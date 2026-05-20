const Anthropic = require('@anthropic-ai/sdk');
const { getSupplierQuoteExtractorPrompt } = require('./prompts');
const db = require('../db/connection');
require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Extract flight quotes from a supplier's WhatsApp group message using Claude AI.
 *
 * @param {string} supplierMessage - The raw WhatsApp message from the supplier group
 * @param {object} [options] - Optional settings
 * @param {string} [options.groupName='Unknown Group'] - Name of the WhatsApp supplier group
 * @param {string} [options.supplierName='Unknown'] - Name of the supplier who sent the message
 * @param {boolean} [options.saveToDb=false] - Whether to save quotes to the database
 * @param {string} [options.inquiryId] - Inquiry UUID to link these quotes to (required if saveToDb)
 * @returns {Promise<Array>} Array of parsed quote objects
 */
async function extractSupplierQuotes(supplierMessage, options = {}) {
    const {
        groupName = 'Unknown Group',
        supplierName = 'Unknown',
        saveToDb = false,
        inquiryId = null,
    } = options;

    console.log('\n[QuoteExtractor] Processing message from', groupName);
    console.log('[QuoteExtractor] Message:', supplierMessage.substring(0, 100));

    const systemPrompt = getSupplierQuoteExtractorPrompt();

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 2048,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: supplierMessage,
                },
            ],
        });

        // Extract the text content from Claude's response
        const rawText = response.content[0].text.trim();

        // Parse the JSON from the response (handle markdown code blocks)
        let jsonText = rawText;
        if (jsonText.startsWith('```')) {
            jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }

        const quotes = JSON.parse(jsonText);

        if (!Array.isArray(quotes)) {
            throw new Error('Expected an array of quotes, got: ' + typeof quotes);
        }

        console.log(`[QuoteExtractor] Extracted ${quotes.length} quote(s)`);
        quotes.forEach((q, i) => {
            console.log(`  [${i + 1}] ${q.airline || 'Unknown'} ${q.route || ''} - ${q.currency || 'NGN'} ${q.price || '?'} (confidence: ${q.confidence})`);
        });

        // Save to database if requested
        if (saveToDb && inquiryId && quotes.length > 0) {
            const savedIds = await saveQuotesToDb(quotes, inquiryId, groupName, supplierName, supplierMessage);
            console.log(`[QuoteExtractor] Saved ${savedIds.length} quote(s) to DB`);
            // Attach DB IDs to the quotes
            quotes.forEach((q, i) => {
                if (savedIds[i]) q._db_quote_id = savedIds[i];
            });
        }

        return quotes;
    } catch (error) {
        console.error('[QuoteExtractor] Error:', error.message);
        throw error;
    }
}

/**
 * Save parsed quotes to the supplier_quotes table.
 */
async function saveQuotesToDb(quotes, inquiryId, groupName, supplierName, rawMessage) {
    const savedIds = [];

    for (const quote of quotes) {
        try {
            const result = await db.query(
                `INSERT INTO supplier_quotes (
          inquiry_id, supplier_group_name, supplier_name, airline, flight_number,
          departure_time, arrival_time, price_amount, price_currency, class,
          stops, raw_message, ai_confidence_score, source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'whatsapp_group')
        RETURNING id`,
                [
                    inquiryId,
                    groupName,
                    supplierName,
                    quote.airline || null,
                    null, // flight_number not always extracted
                    quote.departure_time && quote.date
                        ? `${quote.date}T${quote.departure_time}:00`
                        : null,
                    quote.arrival_time && quote.date
                        ? `${quote.date}T${quote.arrival_time}:00`
                        : null,
                    quote.price || 0,
                    quote.currency || 'NGN',
                    quote.class || 'economy',
                    quote.stops || 0,
                    rawMessage,
                    quote.confidence || 0,
                ]
            );
            savedIds.push(result.rows[0].id);
        } catch (err) {
            console.error(`[QuoteExtractor] Failed to save quote for ${quote.airline}:`, err.message);
            savedIds.push(null);
        }
    }

    return savedIds;
}

module.exports = { extractSupplierQuotes };
