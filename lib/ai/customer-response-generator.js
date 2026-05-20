const Anthropic = require('@anthropic-ai/sdk');
const { getCustomerResponseGeneratorPrompt } = require('./prompts');
require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate a ranked list of quotes and a formatted WhatsApp message for the customer.
 * 
 * @param {object} customerInfo - { name, inquiry }
 * @param {Array} quotes - Array of quote objects from all sources
 * @returns {Promise<object>} Ranked quotes and the WhatsApp message
 */
async function generateCustomerResponse(customerInfo, quotes) {
    console.log(`\n[ResponseGenerator] Ranking ${quotes.length} quotes for ${customerInfo.name || 'Customer'}`);

    const systemPrompt = getCustomerResponseGeneratorPrompt();

    const inputData = {
        customer_name: customerInfo.name || 'there',
        inquiry: customerInfo.inquiry,
        quotes: quotes
    };

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest', // Using the specified Claude 3.5 Sonnet model
            max_tokens: 2048,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: JSON.stringify(inputData, null, 2),
                },
            ],
        });

        const rawText = response.content[0].text.trim();

        // Parse JSON from response
        let jsonText = rawText;
        if (jsonText.includes('```json')) {
            jsonText = jsonText.match(/```json([\s\S]*?)```/)[1].trim();
        } else if (jsonText.startsWith('```')) {
            jsonText = jsonText.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        const result = JSON.parse(jsonText);
        console.log('[ResponseGenerator] Generated response successfully.');

        return result;
    } catch (error) {
        console.error('[ResponseGenerator] Error:', error.message);
        throw error;
    }
}

module.exports = { generateCustomerResponse };
