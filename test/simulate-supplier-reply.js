const axios = require('axios');

async function simulateSupplierReply() {
    console.log("=== SIMULATING SUPPLIER REPLY FLOW ===");

    const PORT = process.env.PORT || 3001;
    const GROUP_ID = "12345678@g.us";

    try {
        // 1. Simulating a supplier reply in a group
        console.log(`\n[Simulator] 🔥 Triggering reply from 'Global Travel Inc' in group ${GROUP_ID}`);
        const replyText = "Air Peace LOS-ABV 45k 7am available. Ibom air 48k 9am.";

        const res = await axios.post(`http://localhost:${PORT}/webhook/evolution`, {
            group_id: GROUP_ID,
            sender_name: "Global Travel Inc",
            text: replyText,
            fromMe: false
        });

        console.log(`[Simulator] Result:`, JSON.stringify(res.data, null, 2));

    } catch (error) {
        console.error(`[Simulator] Error:`, error.response?.data || error.message);
    }
}

simulateSupplierReply();
