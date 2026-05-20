'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getCompetitiveRankerPrompt } = require('./prompts');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Rank portal search results for a group request and pre-fill an agent response.
 *
 * @param {object} inquiry  - Inquiry row from the DB
 * @param {Array}  results  - Array of StandardizedFlight objects from portal searches
 * @returns {Promise<{ranked: Array, suggested_response: string}>}
 */
async function rankPortalResults(inquiry, results) {
    console.log(`[Ranker] Ranking ${results.length} result(s) for inquiry ${inquiry.id}`);

    const input = {
        request: {
            origin:       inquiry.origin_code,
            destination:  inquiry.destination_code,
            date:         inquiry.departure_date,
            passengers:   inquiry.passengers_adult || 1,
            travel_class: inquiry.travel_class || 'economy',
            raw_message:  inquiry.raw_message,
        },
        results: results.map((r, i) => ({
            index:          i,
            airline:        r.airline,
            flight_number:  r.flight_number,
            departure_time: r.departure_time,
            arrival_time:   r.arrival_time,
            price:          r.price,
            currency:       r.currency || 'NGN',
            stops:          r.stops ?? 0,
            portal:         r.portal_name,
        })),
    };

    const response = await anthropic.messages.create({
        model:      'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        system:     getCompetitiveRankerPrompt(),
        messages:   [{ role: 'user', content: JSON.stringify(input) }],
    });

    const raw = response.content[0].text.trim()
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '');

    const parsed = JSON.parse(raw);
    console.log(`[Ranker] Top pick: index ${parsed.ranked?.[0]?.quote_index} — "${parsed.suggested_response?.substring(0, 60)}"`);
    return parsed;
}

module.exports = { rankPortalResults };
