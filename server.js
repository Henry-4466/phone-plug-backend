require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const BASE_URL = process.env.BASE_URL || 'https://sandbox.safaricom.co.ke';
const USE_MOCK = BASE_URL.includes('localhost') || BASE_URL.includes('4000');

console.log('=== CONFIGURATION ===');
console.log('BASE_URL:', BASE_URL);
console.log('USE_MOCK:', USE_MOCK);
console.log('PORT:', process.env.PORT || 3000);
console.log('====================');

const transactions = new Map();

// Helper: Get OAuth Token
async function getAccessToken() {
    const consumerKey = process.env.CONSUMER_KEY;
    const consumerSecret = process.env.CONSUMER_SECRET;
    
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    try {
        const response = await axios.get(
            `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            { headers: { Authorization: `Basic ${auth}` } }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Token error:', error.response?.data || error.message);
        throw error;
    }
}

// Helper: Format phone number
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
    else if (cleaned.startsWith('7')) cleaned = '254' + cleaned;
    return cleaned;
}

// API: Initiate STK Push
app.post('/api/pay', async (req, res) => {
    const { phone, amount, orderNumber, customerName } = req.body;
    
    if (!phone || !amount || amount < 1) {
        return res.status(400).json({ success: false, message: 'Valid phone number and amount required' });
    }
    
    try {
        const formattedPhone = formatPhoneNumber(phone);
        const accessToken = await getAccessToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        
        // Different request body for mock vs real
        let requestBody;
        
        if (USE_MOCK) {
            // mpesa-mock format
            requestBody = {
                BusinessShortCode: '174379',
                Password: 'test123',
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.round(amount),
                PartyA: formattedPhone,
                PartyB: '174379',
                PhoneNumber: formattedPhone,
                CallBackURL: process.env.CALLBACK_URL || 'http://localhost:3000/api/callback',
                AccountReference: `ORD${Date.now().toString().slice(-6)}`,
                TransactionDesc: 'PAY'
            };
        } else {
            // Real Safaricom format
            const password = Buffer.from(
                `${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`
            ).toString('base64');
            
            requestBody = {
                BusinessShortCode: process.env.SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.round(amount),
                PartyA: formattedPhone,
                PartyB: process.env.SHORTCODE,
                PhoneNumber: formattedPhone,
                CallBackURL: process.env.CALLBACK_URL,
                AccountReference: orderNumber || `PPH${Date.now()}`,
                TransactionDesc: 'Payment'
            };
        }
        
        console.log('Sending request to:', `${BASE_URL}/mpesa/stkpush/v1/processrequest`);
        console.log('Phone:', formattedPhone, 'Amount:', amount);
        
        const response = await axios.post(
            `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
            requestBody,
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        
        transactions.set(response.data.CheckoutRequestID, {
            orderNumber, phone: formattedPhone, amount, customerName, status: 'pending', timestamp: new Date()
        });
        
        res.json({ success: true, message: 'STK Push sent', checkoutRequestId: response.data.CheckoutRequestID });
        
    } catch (error) {
        console.error('Payment error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: error.response?.data?.errorMessage || 'Payment failed' });
    }
});

// API: Check status
app.post('/api/status', (req, res) => {
    const { checkoutRequestId } = req.body;
    const transaction = transactions.get(checkoutRequestId);
    if (transaction) {
        res.json({ success: true, status: transaction.status, transaction });
    } else {
        res.json({ success: false, message: 'Transaction not found' });
    }
});

// API: Callback endpoint
app.post('/api/callback', (req, res) => {
    console.log('Callback received - ResultCode:', req.body?.Body?.stkCallback?.ResultCode);
    
    try {
        const callbackData = req.body.Body.stkCallback;
        const transaction = transactions.get(callbackData.CheckoutRequestID);
        
        if (transaction) {
            if (callbackData.ResultCode === 0) {
                transaction.status = 'completed';
                console.log(`✅ Payment successful for ${transaction.orderNumber}`);
            } else {
                transaction.status = 'failed';
                console.log(`❌ Payment failed: ${callbackData.ResultDesc}`);
            }
        }
        res.json({ ResultCode: 0, ResultDesc: 'Success' });
    } catch (error) {
        res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Base URL: ${BASE_URL}`);
});
