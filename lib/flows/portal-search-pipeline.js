'use strict';

const db                  = require('../db/connection');
const { portalManager }   = require('../portals/portal-manager');
const { rankPortalResults } = require('../ai/competitive-ranker');
const { notifyDashboard } = require('../utils/dashboard-notify');

/**
 * Full pipeline for Option B:
 *   inquiry (pending) → search portals → rank results → notify dashboard (ranked)
 *
 * Called by the group handler immediately after a flight request is detected.
 * Runs asynchronously — the webhook response does not wait for this.
 *
 * @param {object} inquiry - Full inquiry row from the DB (from detectGroupRequest)
 */
async function runPortalSearch(inquiry) {
    const id = inquiry.id;
    console.log(`\n[Pipeline] ── Starting search for inquiry ${id} ──`);
    console.log(`[Pipeline] Route: ${inquiry.origin_code} → ${inquiry.destination_code} | Date: ${inquiry.departure_date} | Pax: ${inquiry.passengers_adult}`);

    try {
        // ── 1. Mark as searching ──────────────────────────────────────────────
        await db.query(
            `UPDATE inquiries SET status = 'searching', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        await notifyDashboard('request_detected', {
            inquiry_id:    id,
            origin:        inquiry.origin_code,
            destination:   inquiry.destination_code,
            date:          inquiry.departure_date,
            passengers:    inquiry.passengers_adult,
            raw_message:   inquiry.raw_message,
            group_jid:     inquiry.group_jid,
        });

        // ── 2. Search all portals in parallel ─────────────────────────────────
        const searchStart = Date.now();

        let results = [];

        if (process.env.PORTALS_ENABLED === 'false') {
            console.log('[Pipeline] PORTALS_ENABLED=false — skipping live portal search.');
        } else if (!portalManager.initialized) {
            console.warn('[Pipeline] PortalManager not initialized — skipping portal search.');
        } else {
            results = await portalManager.search({
                origin:      inquiry.origin_code,
                destination: inquiry.destination_code,
                date:        inquiry.departure_date,
                passengers:  inquiry.passengers_adult || 1,
                classType:   inquiry.travel_class || 'economy',
                inquiryId:   id,
            });
        }

        const elapsed = ((Date.now() - searchStart) / 1000).toFixed(1);
        console.log(`[Pipeline] Portal search complete — ${results.length} result(s) in ${elapsed}s`);

        // ── 3. Save results to portal_quotes ─────────────────────────────────
        const savedQuotes = await savePortalQuotes(id, results);
        console.log(`[Pipeline] Saved ${savedQuotes.length} quote(s) to DB`);

        if (savedQuotes.length === 0) {
            await db.query(
                `UPDATE inquiries SET status = 'ranked', updated_at = NOW() WHERE id = $1`,
                [id]
            );
            await notifyDashboard('search_complete', {
                inquiry_id: id,
                quotes:     [],
                suggested_response: null,
                message: 'No results found on portals for this route.',
            });
            console.log(`[Pipeline] No results — inquiry ${id} marked ranked with empty quotes.`);
            return;
        }

        // ── 4. Rank results with Claude ───────────────────────────────────────
        let ranked = null;
        let suggestedResponse = null;

        try {
            const ranking = await rankPortalResults(inquiry, results);
            ranked            = ranking.ranked || [];
            suggestedResponse = ranking.suggested_response || null;
        } catch (rankErr) {
            console.error('[Pipeline] Ranker failed — will send unranked results to dashboard:', rankErr.message);
        }

        // ── 5. Persist ranked order on inquiry ────────────────────────────────
        const rankedQuoteIds = (ranked || []).map(r => ({
            rank:       r.rank,
            quote_id:   savedQuotes[r.quote_index]?.id || null,
            portal:     savedQuotes[r.quote_index]?.portal_name || null,
            reason:     r.reason || null,
        })).filter(r => r.quote_id);

        await db.query(
            `UPDATE inquiries
             SET status = 'ranked', ranked_quote_ids = $1, suggested_response = $2, updated_at = NOW()
             WHERE id = $3`,
            [JSON.stringify(rankedQuoteIds), suggestedResponse || null, id]
        );

        // ── 6. Push to dashboard ──────────────────────────────────────────────
        // Build the ordered quote list for the agent UI (ranked first, rest appended)
        const rankedIndexes = (ranked || []).map(r => r.quote_index);
        const orderedQuotes = [
            ...rankedIndexes.map(i => savedQuotes[i]).filter(Boolean),
            ...savedQuotes.filter((_, i) => !rankedIndexes.includes(i)),
        ];

        await notifyDashboard('search_complete', {
            inquiry_id:         id,
            origin:             inquiry.origin_code,
            destination:        inquiry.destination_code,
            date:               inquiry.departure_date,
            passengers:         inquiry.passengers_adult,
            raw_message:        inquiry.raw_message,
            group_jid:          inquiry.group_jid,
            quotes:             orderedQuotes,
            suggested_response: suggestedResponse,
            elapsed_seconds:    parseFloat(elapsed),
        });

        console.log(`[Pipeline] ✓ Inquiry ${id} ready — ${savedQuotes.length} quote(s) pushed to dashboard`);

    } catch (err) {
        console.error(`[Pipeline] Fatal error for inquiry ${id}:`, err.message);
        await db.query(
            `UPDATE inquiries SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
            [id]
        ).catch(() => {});
    }
}

/**
 * Insert portal search results into the portal_quotes table.
 * Returns the saved rows (with IDs assigned by the DB).
 *
 * @param {string} inquiryId
 * @param {Array}  results   - StandardizedFlight objects from portalManager.search()
 * @returns {Promise<Array>}
 */
async function savePortalQuotes(inquiryId, results) {
    if (!results.length) return [];

    const saved = [];

    for (const r of results) {
        try {
            const res = await db.query(
                `INSERT INTO portal_quotes (
                    inquiry_id, portal_name, airline, flight_number,
                    departure_time, arrival_time,
                    price_amount, price_currency,
                    class, stops, baggage_allowance, booking_code,
                    raw_response
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                RETURNING *`,
                [
                    inquiryId,
                    r.portal_name,
                    r.airline,
                    r.flight_number  || 'TBC',
                    r.departure_time || null,
                    r.arrival_time   || null,
                    r.price,
                    r.currency       || 'NGN',
                    r.class          || 'economy',
                    r.stops          ?? 0,
                    r.baggage        || null,
                    r.booking_code   || null,
                    JSON.stringify(r),
                ]
            );
            // Attach the index so ranking can reference it
            saved.push({ ...res.rows[0], _index: saved.length });
        } catch (err) {
            console.error(`[Pipeline] Failed to save quote (${r.airline} ${r.flight_number}):`, err.message);
        }
    }

    return saved;
}

module.exports = { runPortalSearch };
