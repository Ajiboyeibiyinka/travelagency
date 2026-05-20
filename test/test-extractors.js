/**
 * Test script for both AI extractors
 * Run: node test/test-extractors.js
 */
require('dotenv').config();
const { extractFlightDetails } = require('../lib/ai/flight-detail-extractor');
const { extractSupplierQuotes } = require('../lib/ai/supplier-quote-extractor');

// ─── Sample Customer Messages ───────────────────────────────
const customerMessages = [
    "I wan fly from Lagos to Abuja next Friday, 2 people. Not more than 200k abeg",
    "Good morning, I need a business class ticket from Port Harcourt to London for March 20th. One adult and one child.",
    "How much is Lagos to Dubai economy? Tomorrow morning flight for 3 adults",
    "Hello, just checking in. How are you?",
];

// ─── Sample Supplier Messages ───────────────────────────────
const supplierMessages = [
    {
        message: "AP LOS-ABV 45k 7am tomoro available 2 seats",
        group: "Naija Domestic Flights Deals",
    },
    {
        message: "I have Air Peace Lagos to Abuja 40k and 45k for tomorrow morning. Afternoon flight 38k. Call me",
        group: "Naija Domestic Flights Deals",
    },
    {
        message: "Emirates Lagos London March 15 850k economy via Dubai",
        group: "Global Wings International Fares",
    },
    {
        message: "Good morning everyone! Who has LOS-ABV?",
        group: "Naija Domestic Flights Deals",
    },
];

// ─── Run Tests ──────────────────────────────────────────────
async function runTests() {
    console.log('='.repeat(70));
    console.log('  FLIGHT DETAIL EXTRACTOR — Customer Message Tests');
    console.log('='.repeat(70));

    for (let i = 0; i < customerMessages.length; i++) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`TEST ${i + 1}: "${customerMessages[i]}"`);
        console.log('─'.repeat(60));

        try {
            const result = await extractFlightDetails(customerMessages[i]);
            console.log('\nRESULT:');
            console.log(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error('FAILED:', err.message);
        }
    }

    console.log('\n\n' + '='.repeat(70));
    console.log('  SUPPLIER QUOTE EXTRACTOR — Group Message Tests');
    console.log('='.repeat(70));

    for (let i = 0; i < supplierMessages.length; i++) {
        const { message, group } = supplierMessages[i];
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`TEST ${i + 1}: "${message}"`);
        console.log(`GROUP: ${group}`);
        console.log('─'.repeat(60));

        try {
            const result = await extractSupplierQuotes(message, { groupName: group });
            console.log('\nRESULT:');
            console.log(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error('FAILED:', err.message);
        }
    }

    console.log('\n\n' + '='.repeat(70));
    console.log('  ALL TESTS COMPLETE');
    console.log('='.repeat(70));

    process.exit(0);
}

// Check for API key before running
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'sk-ant-your-key-here') {
    console.error('\n❌ ANTHROPIC_API_KEY not set!');
    console.error('   Edit .env and add your Anthropic API key.');
    console.error('   Get one at: https://console.anthropic.com\n');
    process.exit(1);
}

runTests().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
