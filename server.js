require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Base URL for API calls (defaults to sandbox if not set)
const BASE_URL = process.env.BASE_URL || 'https://sandbox.safaricom.co.ke';

// Debug: Check if .env loaded correctly
console.log('=== ENV VARIABLES CHECK ===');
console.log('PORT:', process.env.PORT);
console.log('BASE_URL:', BASE_URL);
console.log('SHORTCODE:', process.env.SHORTCODE);
console.log('CALLBACK_URL:', process.env.CALLBACK_URL);
console.log('CONSUMER_KEY exists:', process.env.CONSUMER_KEY ? 'YES (length: ' + process.env.CONSUMER_KEY.length + ')' : 'NO');
console.log('CONSUMER_SECRET exists:', process.env.CONSUMER_SECRET ? 'YES (length: ' + process.env.CONSUMER_SECRET.length + ')' : 'NO');
console.log('PASSKEY exists:', process.env.PASSKEY ? 'YES' : 'NO');
console.log('===========================');

// Store transactions temporarily (use a database in production)
const transactions = new Map();

// Helper: Get OAuth Token from Daraja or Mock
async function getAccessToken() {
    const consumerKey = process.env.CONSUMER_KEY;
    const consumerSecret = process.env.CONSUMER_SECRET;
    
    console.log('Getting token from:', `${BASE_URL}/oauth/v1/generate`);
    
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    try {
        const response = await axios.get(
            `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );
        console.log('✅ Token obtained successfully');
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting token:', error.response?.data || error.message);
        throw error;
    }
}

// Helper: Format phone number to 254XXXXXXXXX format
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('254')) {
        cleaned = cleaned;
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }
    
    return cleaned;
}

// API Endpoint: Initiate STK Push
app.post('/api/pay', async (req, res) => {
    const { phone, amount, orderNumber, customerName } = req.body;
    
    if (!phone || !amount || amount < 1) {
        return res.status(400).json({ 
            success: false, 
            message: 'Valid phone number and amount are required' 
        });
    }
    
    try {
        const formattedPhone = formatPhoneNumber(phone);
        const accessToken = await getAccessToken();
        
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(
            `${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`
        ).toString('base64');
        
        const requestBody = {
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
            TransactionDesc: `Payment for order ${orderNumber || 'Phone Plug Hub'}`
        };
        
        console.log('Sending STK Push to:', `${BASE_URL}/mpesa/stkpush/v1/processrequest`);
        console.log('Request body:', requestBody);
        
        const response = await axios.post(
            `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
            requestBody,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );
        
        transactions.set(response.data.CheckoutRequestID, {
            orderNumber: orderNumber,
            phone: formattedPhone,
            amount: amount,
            customerName: customerName,
            status: 'pending',
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: 'STK Push sent successfully',
            checkoutRequestId: response.data.CheckoutRequestID,
            responseCode: response.data.ResponseCode
        });
        
    } catch (error) {
        console.error('STK Push error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.errorMessage || 'Failed to initiate payment'
        });
    }
});

// API Endpoint: Check transaction status
app.post('/api/status', async (req, res) => {
    const { checkoutRequestId } = req.body;
    
    const transaction = transactions.get(checkoutRequestId);
    if (transaction) {
        res.json({
            success: true,
            status: transaction.status,
            transaction: transaction
        });
    } else {
        res.json({
            success: false,
            message: 'Transaction not found'
        });
    }
});

// Callback URL: Safaricom sends payment confirmation here
app.post('/api/callback', async (req, res) => {
    console.log('Callback received:', JSON.stringify(req.body, null, 2));
    
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;
        
        const transaction = transactions.get(checkoutRequestId);
        
        if (transaction) {
            if (resultCode === 0) {
                transaction.status = 'completed';
                transaction.mpesaReceipt = callbackData.CallbackMetadata?.Item?.find(
                    item => item.Name === 'MpesaReceiptNumber'
                )?.Value;
                transaction.transactionDate = callbackData.CallbackMetadata?.Item?.find(
                    item => item.Name === 'TransactionDate'
                )?.Value;
                
                console.log(`✅ Payment successful for order ${transaction.orderNumber}`);
                console.log(`Receipt: ${transaction.mpesaReceipt}`);
            } else {
                transaction.status = 'failed';
                transaction.failureReason = callbackData.ResultDesc;
                console.log(`❌ Payment failed: ${callbackData.ResultDesc}`);
            }
        }
        
        res.json({ ResultCode: 0, ResultDesc: 'Success' });
        
    } catch (error) {
        console.error('Callback processing error:', error);
        res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test auth endpoint
app.get('/api/test-auth', async (req, res) => {
    try {
        const token = await getAccessToken();
        res.json({ success: true, message: 'Token obtained', token: token.substring(0, 20) + '...' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Callback URL is: ${process.env.CALLBACK_URL}`);
    console.log(`Using API base URL: ${BASE_URL}`);
});
