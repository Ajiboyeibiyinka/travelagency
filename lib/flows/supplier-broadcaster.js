const { pool } = require('../db/connection');
const Anthropic = require('@anthropic-ai/sdk');
const { getSupplierRequestVariatorPrompt } = require('../ai/prompts');
const { sendGroupMessage } = require('../whatsapp/evolution-api');

require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * ORCHESTRATOR: Supplier Group Broadcaster Workflow
 * Variations the inquiry and posts to multiple supplier groups.
 */
async function broadcastInquiry(inquiryId) {
    console.log(`\n[Broadcaster] Starting broadcast for Inquiry ID: ${inquiryId}`);

    const client = await pool.connect();
    let inquiry = null; // declared here so catch block can reference it safely
    try {
        // 1. Fetch Inquiry Details
        const inquiryRes = await client.query(
            "SELECT * FROM public.inquiries WHERE id = $1",
            [inquiryId]
        );

        if (inquiryRes.rows.length === 0) {
            throw new Error(`Inquiry ${inquiryId} not found.`);
        }
        inquiry = inquiryRes.rows[0];

        // 2. Update status IMMEDIATELY to 'searching' so we can match incoming replies
        await client.query(
            "UPDATE public.inquiries SET status = 'searching' WHERE id = $1",
            [inquiryId]
        );

        // 3. Generate AI Variations
        console.log(`[Broadcaster] Generating AI variations...`);
        const message = await anthropic.messages.create({
            model: "claude-3-5-sonnet-latest",
            max_tokens: 500,
            system: "You are a professional travel agent. Return only the JSON array requested.",
            messages: [{ role: "user", content: getSupplierRequestVariatorPrompt(inquiry) }],
        });

        const variations = JSON.parse(message.content[0].text);
        console.log(`[Broadcaster] Generated ${variations.length} variations.`);

        // 3. Fetch Active Groups
        const groupsRes = await client.query(
            "SELECT * FROM public.supplier_groups WHERE is_active = true"
        );
        const groups = groupsRes.rows;
        console.log(`[Broadcaster] Found ${groups.length} active groups.`);

        if (groups.length === 0) {
            console.log(`[Broadcaster] No active groups found. Stopping.`);
            return;
        }

        // 4. Staggered Broadcast Loop
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const variation = variations[i % variations.length]; // Cycle through variations

            // Random delay between posts (30-90s)
            // For testing, we shrink this significantly to avoid timeouts
            const delayMs = i === 0 ? 0 : (Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000);
            // REAL LOGIC: Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000

            if (delayMs > 0) {
                console.log(`[Broadcaster] Waiting ${delayMs / 1000}s before next group...`);
                await new Promise(r => setTimeout(r, delayMs));
            }

            console.log(`[Broadcaster] Posting to ${group.group_name} (${group.group_whatsapp_id})...`);
            const evoRes = await sendGroupMessage(group.group_whatsapp_id, variation);

            // 5. Log Broadcast in conversations
            await client.query(
                `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel, whatsapp_message_id) 
                 VALUES ($1, $2, 'outbound', $3, 'text', 'supplier_group', $4)`,
                [inquiry.customer_id, inquiryId, variation, evoRes.messageId]
            );
        }

        // 6. Update status
        await client.query(
            "UPDATE public.inquiries SET status = 'searching' WHERE id = $1",
            [inquiryId]
        );

        console.log(`[Broadcaster] Broadcast complete for Inquiry ID: ${inquiryId}`);

    } catch (error) {
        console.error(`[Broadcaster] Error during broadcast:`, error);
        if (inquiry) {
            console.warn(`[Broadcaster] Broadcast failed for ${inquiry.origin_code}-${inquiry.destination_code} (Inquiry: ${inquiryId})`);
        }
    } finally {
        client.release();
    }
}

module.exports = { broadcastInquiry };
