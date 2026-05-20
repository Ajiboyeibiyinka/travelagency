const Anthropic = require('@anthropic-ai/sdk');
const { getSelectionParserPrompt, getPassengerDetailExtractorPrompt } = require('./prompts');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Parse a customer's reply to determine which numbered flight option they selected.
 *
 * @param {string} message - Raw customer reply (e.g. "1", "option 2", "the first one")
 * @param {Array} rankedQuotes - Ordered array of quote objects (rank 1 = index 0)
 * @returns {Promise<{ selected_rank: number|null, confidence: number, reason?: string }>}
 */
async function parseCustomerSelection(message, rankedQuotes) {
    console.log(`\n[BookingExtractor] Parsing selection from: "${message}"`);

    const systemPrompt = getSelectionParserPrompt(rankedQuotes);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 256,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }],
        });

        const rawText = response.content[0].text.trim();
        let jsonText = rawText.startsWith('```')
            ? rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
            : rawText;

        const result = JSON.parse(jsonText);
        console.log(`[BookingExtractor] Selection parsed — rank: ${result.selected_rank}, confidence: ${result.confidence}`);
        return result;
    } catch (error) {
        console.error('[BookingExtractor] parseCustomerSelection error:', error.message);
        throw error;
    }
}

/**
 * Extract a single passenger's travel details from a WhatsApp message.
 *
 * @param {string} message - Raw customer message with passenger details
 * @param {object} options
 * @param {boolean} options.isInternational - Whether the flight is international
 * @param {number} options.passengerNumber - Which passenger we're collecting (1-based)
 * @param {number} options.totalPassengers - Total passengers on the booking
 * @returns {Promise<object>} Extracted passenger object with missing_fields array
 */
async function extractPassengerDetails(message, options = {}) {
    const { isInternational = false, passengerNumber = 1, totalPassengers = 1 } = options;
    console.log(`\n[BookingExtractor] Extracting passenger ${passengerNumber}/${totalPassengers} details`);

    const systemPrompt = getPassengerDetailExtractorPrompt(isInternational, passengerNumber, totalPassengers);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }],
        });

        const rawText = response.content[0].text.trim();
        let jsonText = rawText.startsWith('```')
            ? rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
            : rawText;

        const result = JSON.parse(jsonText);
        console.log(`[BookingExtractor] Passenger extracted — name: "${result.full_name}", missing: [${(result.missing_fields || []).join(', ')}]`);
        return result;
    } catch (error) {
        console.error('[BookingExtractor] extractPassengerDetails error:', error.message);
        throw error;
    }
}

module.exports = { parseCustomerSelection, extractPassengerDetails };
