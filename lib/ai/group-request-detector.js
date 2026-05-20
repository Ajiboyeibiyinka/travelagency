'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getGroupRequestDetectorPrompt } = require('./prompts');
const db = require('../db/connection');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Detect whether a WhatsApp group message is a flight request.
 * If it is, extract structured flight details and save to DB.
 *
 * @param {string} message        - Raw message text from the group
 * @param {string} groupJid       - WhatsApp group JID (e.g. '120363001234567890@g.us')
 * @param {string} requesterJid   - Sender's JID (e.g. '2348012345678@s.whatsapp.net')
 * @returns {Promise<object|null>} - Saved inquiry row, or null if not a request
 */
async function detectGroupRequest(message, groupJid, requesterJid) {
    console.log(`[RequestDetector] Checking message from ${requesterJid} in ${groupJid}`);
    console.log(`[RequestDetector] Message: "${message.substring(0, 120)}"`);

    let parsed;
    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 512,
            system: getGroupRequestDetectorPrompt(),
            messages: [{ role: 'user', content: message }],
        });

        const raw = response.content[0].text.trim()
            .replace(/^```(?:json)?\n?/, '')
            .replace(/\n?```$/, '');

        parsed = JSON.parse(raw);
    } catch (err) {
        console.error('[RequestDetector] Claude error:', err.message);
        return null;
    }

    if (!parsed.is_request) {
        console.log(`[RequestDetector] Not a request — reason: ${parsed.reason}`);
        return null;
    }

    if (parsed.confidence < 40) {
        console.log(`[RequestDetector] Request detected but confidence too low (${parsed.confidence}) — skipping.`);
        return null;
    }

    // Must have at least origin + destination to be actionable
    if (!parsed.origin_code || !parsed.destination_code) {
        console.log('[RequestDetector] Missing origin or destination — cannot search portals.');
        return null;
    }

    console.log(`[RequestDetector] ✓ Flight request detected (confidence: ${parsed.confidence})`);
    console.log(`[RequestDetector]   Route: ${parsed.origin_code} → ${parsed.destination_code} | Date: ${parsed.departure_date} | Pax: ${parsed.passengers}`);

    const inquiry = await saveInquiry(parsed, message, groupJid, requesterJid);
    return inquiry;
}

/**
 * Save a detected flight request to the inquiries table.
 * @private
 */
async function saveInquiry(parsed, rawMessage, groupJid, requesterJid) {
    const result = await db.query(
        `INSERT INTO inquiries (
            group_jid, requester_jid, raw_message,
            origin_city, origin_code,
            destination_city, destination_code,
            departure_date, return_date,
            passengers_adult, passengers_child, passengers_infant,
            travel_class, trip_type,
            status, source
        ) VALUES (
            $1, $2, $3,
            $4, $5,
            $6, $7,
            $8, $9,
            $10, 0, 0,
            $11, $12,
            'pending', 'supplier_group'
        ) RETURNING *`,
        [
            groupJid,
            requesterJid,
            rawMessage,
            parsed.origin_city   || parsed.origin_code,
            parsed.origin_code,
            parsed.destination_city || parsed.destination_code,
            parsed.destination_code,
            parsed.departure_date || null,
            parsed.return_date    || null,
            parsed.passengers     || 1,
            parsed.travel_class   || 'economy',
            parsed.trip_type      || 'one_way',
        ]
    );

    const inquiry = result.rows[0];
    console.log(`[RequestDetector] Saved inquiry ${inquiry.id}`);
    return inquiry;
}

module.exports = { detectGroupRequest };
