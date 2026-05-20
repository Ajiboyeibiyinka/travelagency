'use strict';

const { pool } = require('../db/connection');
const { portalManager } = require('../portals/portal-manager');

const NIGERIAN_AIRPORTS = new Set([
    'LOS', 'ABV', 'PHC', 'KAN', 'ENU', 'CBQ', 'QOW', 'BNI',
    'AKR', 'MBI', 'ILR', 'JOS', 'SOC', 'MIU', 'YOL', 'QRW', 'QUO', 'ABB', 'KAD',
]);

/**
 * ORCHESTRATOR: Portal Searcher Workflow
 *
 * Runs Puppeteer searches across all enabled airline portals for a given inquiry.
 * Only runs for domestic Nigerian routes (the three adapters are domestic carriers).
 * Results are saved to the portal_quotes table.
 *
 * Called from customer-inquiry-handler.js after the inquiry is created.
 * Runs as a background task (no await at call site).
 *
 * @param {string} inquiryId - UUID of the inquiry
 */
async function searchPortals(inquiryId) {
    console.log(`\n[PortalSearcher] Starting portal search for Inquiry ID: ${inquiryId}`);

    const client = await pool.connect();
    try {
        // 1. Fetch inquiry details
        const inquiryRes = await client.query(
            'SELECT * FROM public.inquiries WHERE id = $1',
            [inquiryId]
        );

        if (inquiryRes.rows.length === 0) {
            throw new Error(`Inquiry ${inquiryId} not found.`);
        }
        const inquiry = inquiryRes.rows[0];

        // 2. Only run for domestic routes (our portal adapters are Nigerian domestic carriers)
        const isDomestic = NIGERIAN_AIRPORTS.has(inquiry.origin_code)
            && NIGERIAN_AIRPORTS.has(inquiry.destination_code);

        if (!isDomestic) {
            console.log(`[PortalSearcher] International route (${inquiry.origin_code}→${inquiry.destination_code}) — skipping local portals.`);
            return;
        }

        console.log(`[PortalSearcher] Domestic route confirmed: ${inquiry.origin_code}→${inquiry.destination_code}`);

        // 3. Build search parameters
        const totalPassengers = (inquiry.passengers_adult || 1)
            + (inquiry.passengers_child  || 0)
            + (inquiry.passengers_infant || 0);

        // departure_date from pg comes as a Date object — format as YYYY-MM-DD
        const departureDate = inquiry.departure_date instanceof Date
            ? inquiry.departure_date.toISOString().split('T')[0]
            : String(inquiry.departure_date).split('T')[0];

        const searchParams = {
            origin:      inquiry.origin_code,
            destination: inquiry.destination_code,
            date:        departureDate,
            passengers:  totalPassengers,
            classType:   inquiry.travel_class || 'economy',
            inquiryId,
        };

        // 4. Run search across all portals via PortalManager
        const portalResults = await portalManager.search(searchParams);
        console.log(`[PortalSearcher] Total portal results received: ${portalResults.length}`);

        if (portalResults.length === 0) {
            console.log('[PortalSearcher] No results from any portal — nothing to save.');
            return;
        }

        // 5. Save results to portal_quotes
        let savedCount = 0;
        for (const quote of portalResults) {
            try {
                await client.query(
                    `INSERT INTO public.portal_quotes (
                        inquiry_id, portal_name, airline, flight_number,
                        price_amount, price_currency, departure_time, arrival_time,
                        class, stops, baggage_allowance, booking_code, raw_response
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                    [
                        inquiryId,
                        quote.portal_name,
                        quote.airline,
                        quote.flight_number || 'TBC',
                        quote.price,
                        quote.currency || 'NGN',
                        quote.departure_time,
                        quote.arrival_time,
                        quote.class || 'economy',
                        quote.stops ?? 0,
                        quote.baggage   || null,
                        quote.booking_code || null,
                        JSON.stringify(quote),
                    ]
                );
                savedCount++;
            } catch (saveErr) {
                console.error(`[PortalSearcher] Failed to save quote (${quote.airline} ${quote.flight_number}):`, saveErr.message);
            }
        }

        console.log(`[PortalSearcher] Saved ${savedCount}/${portalResults.length} portal quote(s) for Inquiry ID: ${inquiryId}`);

    } catch (error) {
        console.error(`[PortalSearcher] Error for Inquiry ${inquiryId}:`, error.message);
    } finally {
        client.release();
    }
}

module.exports = { searchPortals };
