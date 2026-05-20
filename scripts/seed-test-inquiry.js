'use strict';

/**
 * Inserts a realistic test inquiry with portal quotes into the DB.
 * Lets you test the full agent dashboard workflow without real WhatsApp or portals.
 *
 * Usage: node scripts/seed-test-inquiry.js
 */

require('dotenv').config();
const db = require('../lib/db/connection');

async function seed() {
    console.log('Seeding test inquiry...\n');

    // 1. Create the inquiry (simulating a group request that was detected)
    const inquiryRes = await db.query(
        `INSERT INTO inquiries (
            origin_city, origin_code, destination_city, destination_code,
            departure_date, passengers_adult, travel_class, trip_type,
            status, source,
            group_jid, requester_jid, raw_message,
            suggested_response
         ) VALUES (
            'Lagos', 'LOS', 'Abuja', 'ABV',
            CURRENT_DATE + INTERVAL '1 day',
            2, 'economy', 'one_way',
            'ranked', 'supplier_group',
            '120363024512345678@g.us',
            '2348012345678@s.whatsapp.net',
            'Who has LOS ABV tomorrow morning 2 pax economy? Best price please.',
            'Air Peace LOS-ABV 07:00 — ₦47,500/pax (₦95,000 for 2). Direct. Available. Book fast.'
         ) RETURNING id`,
        []
    );

    const inquiryId = inquiryRes.rows[0].id;
    console.log(`✓ Inquiry created: ${inquiryId}`);

    // 2. Insert portal quotes (simulating Crane IBE results)
    const quotes = [
        {
            portal_name: 'airpeace', airline: 'Air Peace', flight_number: 'P4-301',
            departure_time: new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T07:00:00Z'),
            arrival_time:   new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T08:10:00Z'),
            price: 47500, stops: 0, class: 'economy',
        },
        {
            portal_name: 'ibom', airline: 'Ibom Air', flight_number: 'QI-220',
            departure_time: new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T09:30:00Z'),
            arrival_time:   new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T10:40:00Z'),
            price: 45000, stops: 0, class: 'economy',
        },
        {
            portal_name: 'arik', airline: 'Arik Air', flight_number: 'W3-108',
            departure_time: new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T14:00:00Z'),
            arrival_time:   new Date(Date.now() + 86400000).toISOString().replace(/T.*/, 'T15:15:00Z'),
            price: 43000, stops: 0, class: 'economy',
        },
    ];

    const quoteIds = [];
    for (const q of quotes) {
        const r = await db.query(
            `INSERT INTO portal_quotes (
                inquiry_id, portal_name, airline, flight_number,
                departure_time, arrival_time, price_amount, price_currency,
                class, stops, raw_response
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'NGN',$8,$9,$10)
             RETURNING id`,
            [
                inquiryId, q.portal_name, q.airline, q.flight_number,
                q.departure_time, q.arrival_time, q.price,
                q.class, q.stops, JSON.stringify(q),
            ]
        );
        quoteIds.push(r.rows[0].id);
        console.log(`✓ Quote: ${q.airline} ${q.flight_number} — ₦${q.price.toLocaleString()}`);
    }

    // 3. Write ranked_quote_ids (simulating Claude ranking — Ibom cheapest is #1)
    const ranked = [
        { rank: 1, quote_id: quoteIds[1], portal: 'ibom',     reason: 'Cheapest fare' },
        { rank: 2, quote_id: quoteIds[0], portal: 'airpeace', reason: 'Morning slot, reliable' },
        { rank: 3, quote_id: quoteIds[2], portal: 'arik',     reason: 'Afternoon option' },
    ];

    await db.query(
        `UPDATE inquiries SET ranked_quote_ids = $1 WHERE id = $2`,
        [JSON.stringify(ranked), inquiryId]
    );
    console.log('✓ Ranked quote IDs saved\n');

    console.log('─────────────────────────────────────');
    console.log('Done! Open the dashboard and navigate to:');
    console.log(`  http://localhost:3001/inquiries/${inquiryId}`);
    console.log('─────────────────────────────────────');
    console.log('You can now test:');
    console.log('  1. Claim the inquiry (Lock button)');
    console.log('  2. Select a quote, set markup, edit the response');
    console.log('  3. Click "Post to Group" (will call Evolution API if configured)');
    console.log('  4. Click Won / Lost buttons');

    await db.end();
}

seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
