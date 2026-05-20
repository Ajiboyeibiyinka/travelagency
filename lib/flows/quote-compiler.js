const { pool } = require('../db/connection');
const { generateCustomerResponse } = require('../ai/customer-response-generator');
const { sendWhatsAppMessage } = require('../whatsapp/api');

/**
 * ORCHESTRATOR: Quote Compiler Workflow
 * Aggregates quotes, ranks them via AI, and sends the final response to the customer.
 */
async function compileAndSendQuotes(inquiryId) {
    console.log(`\n[QuoteCompiler] Starting compilation for Inquiry ID: ${inquiryId}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch Inquiry & Customer Details
        const inquiryRes = await client.query(`
            SELECT i.*, c.name as customer_name, c.phone as customer_phone
            FROM public.inquiries i
            JOIN public.customers c ON i.customer_id = c.id
            WHERE i.id = $1
        `, [inquiryId]);

        if (inquiryRes.rows.length === 0) {
            throw new Error(`Inquiry ${inquiryId} not found.`);
        }
        const inquiry = inquiryRes.rows[0];

        // 2. Fetch All Quotes
        const supplierQuotesRes = await client.query(
            "SELECT * FROM public.supplier_quotes WHERE inquiry_id = $1",
            [inquiryId]
        );
        const portalQuotesRes = await client.query(
            "SELECT * FROM public.portal_quotes WHERE inquiry_id = $1",
            [inquiryId]
        );

        const allQuotes = [
            ...supplierQuotesRes.rows.map(q => ({ ...q, source: 'whatsapp_group' })),
            ...portalQuotesRes.rows.map(q => ({ ...q, source: 'airline_portal' }))
        ];

        console.log(`[QuoteCompiler] Found ${allQuotes.length} total quotes.`);

        // 3. Guardrail: No quotes?
        if (allQuotes.length === 0) {
            console.log(`[QuoteCompiler] 0 quotes found. Sending "Still searching" status update.`);
            const waitMsg = `I'm still searching for the best options for your flight to ${inquiry.destination_city}. 🔍\n\nIt's taking a bit longer than usual today, but I'll have results for you shortly!`;
            await sendWhatsAppMessage(inquiry.customer_phone, waitMsg);

            await client.query('COMMIT');
            return;
        }

        // 4. AI Quote Comparator & Message Generation
        console.log(`[QuoteCompiler] Calling AI to rank and format response...`);
        const customerData = {
            customer_name: inquiry.customer_name,
            inquiry: {
                origin: inquiry.origin_city,
                destination: inquiry.destination_city,
                date: inquiry.departure_date,
                passengers: inquiry.passengers_adult + inquiry.passengers_child + inquiry.passengers_infant,
                class: inquiry.travel_class
            }
        };

        const aiResult = await generateCustomerResponse(customerData, allQuotes);
        console.log(`[QuoteCompiler] AI successfully generated response message.`);

        // 4b. Persist ranked quote order so booking-handler can resolve "Option N" correctly.
        // Build a source map: quote UUID → 'whatsapp_group' | 'airline_portal'
        const sourceMap = {};
        allQuotes.forEach(q => { sourceMap[q.id] = q.source; });

        const rankedQuoteIds = (aiResult.ranked_quotes || []).map(r => ({
            rank: r.rank,
            quote_id: r.quote_id,
            source: sourceMap[r.quote_id] || 'whatsapp_group',
            reason: r.reason || null,
        }));

        await client.query(
            "UPDATE public.inquiries SET ranked_quote_ids = $1 WHERE id = $2",
            [JSON.stringify(rankedQuoteIds), inquiryId]
        );
        console.log(`[QuoteCompiler] Saved ${rankedQuoteIds.length} ranked quote IDs to inquiry.`);

        // 5. Send Final Message to Customer
        const whatsappRes = await sendWhatsAppMessage(inquiry.customer_phone, aiResult.whatsapp_message);

        // 6. Log to Conversations
        await client.query(
            `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel, whatsapp_message_id) 
             VALUES ($1, $2, 'outbound', $3, 'text', 'customer_bot', $4)`,
            [inquiry.customer_id, inquiryId, aiResult.whatsapp_message, whatsappRes.messageId]
        );

        // 7. Update Status
        await client.query(
            "UPDATE public.inquiries SET status = 'quotes_ready' WHERE id = $1",
            [inquiryId]
        );

        await client.query('COMMIT');
        console.log(`[QuoteCompiler] Done! Customer notified for Inquiry ID: ${inquiryId}`);

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error(`[QuoteCompiler] Error:`, error.message);
    } finally {
        if (client) client.release();
    }
}

module.exports = { compileAndSendQuotes };
