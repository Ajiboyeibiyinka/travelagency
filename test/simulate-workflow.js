const axios = require('axios');

/**
 * SIMULATOR: WhatsApp Webhook Trigger
 * Sends sample messages to the webhook endpoint to test the full workflow.
 */
async function simulateInquiry(phone, name, text) {
    console.log(`\n[Simulator] 🔥 Triggering flow for: "${text}"`);

    try {
        const PORT = process.env.PORT || 3001;
        const res = await axios.post(`http://localhost:${PORT}/webhook/whatsapp`, {
            from: phone,
            name: name,
            text: text,
            id: `sim_${Date.now()}`
        });

        console.log(`[Simulator] Result:`, res.data);
    } catch (error) {
        console.error(`[Simulator] Error:`, error.response?.data || error.message);
    }
}

async function runTest() {
    console.log("=== STARTING WORKFLOW SIMULATION ===");

    // Test 1: New customer, incomplete inquiry
    await simulateInquiry("2348011112222", "Balami Yusuf", "I want to fly to Lagos from Abuja next week");

    // Wait a bit for logs to settle
    await new Promise(r => setTimeout(r, 2000));

    // Test 2: Complete inquiry (Guaranteed to trigger broadcaster)
    await simulateInquiry("2348033334444", "Chidi Okafor", "One way ticket from Lagos to Abuja for tomorrow morning. 1 adult, economy class. Book it!");

    console.log("\n=== SIMULATION COMPLETE ===");
}

runTest();
