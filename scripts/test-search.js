'use strict';
require('dotenv').config();
const { portalManager } = require('../lib/portals/portal-manager');

async function main() {
    console.log('Initialising portal manager...');
    console.log('(Browser will open — Cloudflare auto-solves in 10-90s on first run)\n');
    await portalManager.initialize();
    console.log('\nStatus:', JSON.stringify(portalManager.getStatus(), null, 2));

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = tomorrow.toISOString().slice(0, 10);
    console.log(`\nSearching LOS→ABV on ${date} for 1 passenger...`);

    const results = await portalManager.search({
        origin:      'LOS',
        destination: 'ABV',
        date,
        passengers:  1,
        classType:   'economy',
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Results: ${results.length} flight(s) found`);
    console.log('─'.repeat(60));
    results.forEach((r, i) => {
        console.log(`\n[${i + 1}] ${r.airline} ${r.flight_number} (${r.portal_name})`);
        console.log(`     Dep: ${r.departure_time || '?'}`);
        console.log(`     Arr: ${r.arrival_time   || '?'}`);
        console.log(`     NGN ${(r.price || 0).toLocaleString()} | ${r.class} | ${r.stops} stop(s)`);
        if (r.seats_available) console.log(`     Seats: ${r.seats_available}`);
        if (r.baggage)         console.log(`     Baggage: ${r.baggage}`);
    });

    await portalManager.shutdown();
}

main().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
