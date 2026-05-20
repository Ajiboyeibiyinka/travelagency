'use strict';

/**
 * WhatsApp message sender — routes through Evolution API.
 * Used for customer-facing 1-to-1 messages.
 */
const axios = require('axios');
require('dotenv').config();

async function sendWhatsAppMessage(phone, text) {
    console.log(`\n[WhatsApp] → ${phone}: "${text.substring(0, 80).replace(/\n/g, ' ')}..."`);

    const baseUrl  = process.env.EVO_API_URL;
    const apiKey   = process.env.EVO_API_KEY;
    const instance = process.env.EVO_INSTANCE_NAME;

    if (!baseUrl || !apiKey || !instance) {
        console.warn('[WhatsApp] EVO_API_URL / EVO_API_KEY / EVO_INSTANCE_NAME not set — message not sent (dev mode).');
        return { success: false, messageId: `wa_mock_${Date.now()}` };
    }

    const response = await axios.post(
        `${baseUrl}/message/sendText/${instance}`,
        {
            number: phone,
            options: { delay: 1200, presence: 'composing' },
            textMessage: { text },
        },
        {
            headers: {
                'apikey': apiKey,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        }
    );

    const messageId = response.data?.key?.id || `evo_${Date.now()}`;
    console.log(`[WhatsApp] Sent — message ID: ${messageId}`);
    return { success: true, messageId };
}

module.exports = { sendWhatsAppMessage };
