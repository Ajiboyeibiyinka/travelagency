const Anthropic = require('@anthropic-ai/sdk');
const { getFlightDetailExtractorPrompt } = require('./prompts');
const db = require('../db/connection');
require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Extract flight details from a customer's WhatsApp message using Claude AI.
 *
 * @param {string} customerMessage - Raw WhatsApp message from the customer
 * @param {object} [options] - Optional settings
 * @param {boolean} [options.saveToDb=false] - Whether to save the inquiry to the database
 * @param {string} [options.customerId] - Customer UUID (required if saveToDb is true)
 * @param {string} [options.source='whatsapp'] - Source of the message
 * @returns {Promise<object>} Parsed flight inquiry object
 */
async function extractFlightDetails(customerMessage, options = {}) {
    const {
        saveToDb = false,
        customerId = null,
        source = 'whatsapp',
    } = options;

    console.log(`\n[FlightExtractor] Processing message: ${customerMessage.substring(0, 100)}`);

    const systemPrompt = getFlightDetailExtractorPrompt();

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: customerMessage,
                },
            ],
        });

        const rawText = response.content[0].text.trim();

        // Parse the JSON from the response (handle markdown code blocks)
        let jsonText = rawText;
        if (jsonText.startsWith('```')) {
            jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }

        const parsed = JSON.parse(jsonText);

        console.log('[FlightExtractor] Parsed successfully. Confidence:', parsed.confidence);
        if (parsed.missing_fields && parsed.missing_fields.length > 0) {
            console.log('[FlightExtractor] Missing fields:', parsed.missing_fields.join(', '));
        }

        // Save to database if requested
        if (saveToDb && customerId && parsed.confidence > 0) {
            const savedInquiry = await saveInquiryToDb(parsed, customerId, source);
            parsed._db_inquiry_id = savedInquiry.id;
            console.log('[FlightExtractor] Saved to DB with ID:', savedInquiry.id);
        }

        return parsed;
    } catch (error) {
        console.error('[FlightExtractor] Error:', error.message);
        throw error;
    }
}

/**
 * Save a parsed flight inquiry to the inquiries table.
 */
async function saveInquiryToDb(parsed, customerId, source) {
    const result = await db.query(
        `INSERT INTO inquiries (
      customer_id, origin_city, origin_code, destination_city, destination_code,
      departure_date, return_date, passengers_adult, passengers_child,
      passengers_infant, travel_class, trip_type, budget_max, special_requests,
      status, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new',$15)
    RETURNING id`,
        [
            customerId,
            parsed.origin_city,
            parsed.origin_code,
            parsed.destination_city,
            parsed.destination_code,
            parsed.departure_date,
            parsed.return_date,
            parsed.passengers_adult || 1,
            parsed.passengers_child || 0,
            parsed.passengers_infant || 0,
            parsed.travel_class || 'economy',
            parsed.trip_type || 'one_way',
            parsed.budget_max,
            parsed.special_requests,
            source,
        ]
    );
    return result.rows[0];
}

module.exports = { extractFlightDetails };
