'use strict';

/**
 * Evolution API client — used for supplier group broadcasts.
 */
const axios = require('axios');
require('dotenv').config();

async function sendGroupMessage(groupId, text) {
    console.log(`\n[Evolution API] → Group ${groupId}: "${text.substring(0, 80).replace(/\n/g, ' ')}..."`);

    const baseUrl  = process.env.EVO_API_URL;
    const apiKey   = process.env.EVO_API_KEY;
    const instance = process.env.EVO_INSTANCE_NAME;

    if (!baseUrl || !apiKey || !instance) {
        console.warn('[Evolution API] EVO_API_URL / EVO_API_KEY / EVO_INSTANCE_NAME not set — message not sent (dev mode).');
        return { success: false, messageId: `evo_mock_${Date.now()}` };
    }

    const response = await axios.post(
        `${baseUrl}/message/sendText/${instance}`,
        {
            number: groupId,
            options: { delay: 1200 },
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
    console.log(`[Evolution API] Sent — message ID: ${messageId}`);
    return { success: true, messageId };
}

module.exports = { sendGroupMessage };
