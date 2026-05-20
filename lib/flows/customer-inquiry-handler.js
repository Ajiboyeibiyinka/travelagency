const { pool } = require('../db/connection');
const { extractFlightDetails } = require('../ai/flight-detail-extractor');
const { sendWhatsAppMessage } = require('../whatsapp/api');
const { scheduleQuoteCompilation } = require('../jobs/scheduler');

/**
 * ORCHESTRATOR: Customer Inquiry Handler Workflow
 * Processes an incoming WhatsApp message from a customer.
 */
async function handleCustomerMessage(payload) {
    const { phone, name, message_text, message_id } = payload;
    console.log(`\n[Workflow] Handling message from ${phone} (${name}): "${message_text}"`);

    const client = await pool.connect();
    try {
        const dbCheck = await client.query('SELECT current_database(), current_user');
        console.log(`[Flow Context] Connected to: ${dbCheck.rows[0].current_database} as ${dbCheck.rows[0].current_user}`);

        await client.query('BEGIN');

        // 1. Check/Create Customer
        let res = await client.query('SELECT id FROM public.customers WHERE phone = $1', [phone]);
        let customerId;

        if (res.rows.length === 0) {
            console.log(`[Workflow] New customer detected. Creating record...`);
            res = await client.query(
                'INSERT INTO public.customers (name, phone) VALUES ($1, $2) RETURNING id',
                [name || 'WhatsApp User', phone]
            );
        }
        customerId = res.rows[0].id;

        // 2. Log Inbound Message
        await client.query(
            `INSERT INTO public.conversations (customer_id, direction, message_text, message_type, whatsapp_message_id, channel) 
             VALUES ($1, 'inbound', $2, 'text', $3, 'customer_bot')`,
            [customerId, message_text, message_id]
        );

        // 3. Check for Active Inquiry
        res = await client.query(
            `SELECT id, status FROM public.inquiries 
             WHERE customer_id = $1 AND status NOT IN ('cancelled', 'ticket_issued')
             ORDER BY created_at DESC LIMIT 1`,
            [customerId]
        );

        // NODE 3 Logic: Route to Booking Handler or log as unactionable
        if (res.rows.length > 0) {
            const activeInquiry = res.rows[0];
            console.log(`[Workflow] Active inquiry found (${activeInquiry.id}, status: ${activeInquiry.status}).`);

            // Link inbound message to this inquiry
            await client.query(
                `UPDATE public.conversations SET inquiry_id = $1
                 WHERE id = (
                     SELECT id FROM public.conversations
                     WHERE customer_id = $2 AND inquiry_id IS NULL
                     ORDER BY created_at DESC LIMIT 1
                 )`,
                [activeInquiry.id, customerId]
            );

            await client.query('COMMIT');

            // Route to booking handler for actionable statuses
            const bookingStatuses = ['quotes_ready', 'customer_confirmed', 'payment'];
            if (bookingStatuses.includes(activeInquiry.status)) {
                // Fetch full inquiry row (with customer details) for the booking handler
                const fullInquiryRes = await pool.query(
                    `SELECT i.*, c.name as customer_name, c.phone as customer_phone
                     FROM public.inquiries i
                     JOIN public.customers c ON i.customer_id = c.id
                     WHERE i.id = $1`,
                    [activeInquiry.id]
                );
                const { handleBookingFlow } = require('./booking-handler');
                return handleBookingFlow(payload, fullInquiryRes.rows[0]);
            }

            // For non-actionable statuses (searching, booked, etc.) just acknowledge
            return { status: 'active_inquiry_exists', inquiry_id: activeInquiry.id, inquiry_status: activeInquiry.status };
        }

        // NODE 4: AI Extraction
        console.log(`[Workflow] Extracting details via Claude...`);
        const extraction = await extractFlightDetails(message_text, {
            saveToDb: false, // We'll save the inquiry ourselves if complete
            customerId
        });
        console.log(`[Workflow] AI Extraction Result:`, JSON.stringify(extraction, null, 2));

        // NODE 5 & 6: Missing Fields Router
        if (extraction.missing_fields && extraction.missing_fields.length > 0) {
            console.log(`[Workflow] Missing fields: ${extraction.missing_fields.join(', ')}`);

            const missingMsg = `Got it! Just need a few more details to find the best flights:
${extraction.missing_fields.map(f => `- ${f.replace(/_/g, ' ')}`).join('\n')}

Could you please provide these?`;

            await sendWhatsAppMessage(phone, missingMsg);

            // Save to conversations table (outbound message from bot to customer)
            await client.query(
                `INSERT INTO public.conversations (customer_id, direction, message_text, message_type, channel) 
                 VALUES ($1, 'outbound', $2, 'text', 'customer_bot')`,
                [customerId, missingMsg]
            );

            await client.query('COMMIT');
            return { status: 'waiting_for_details', missing_fields: extraction.missing_fields };
        }

        // NODE 7: Create Inquiry Record
        console.log(`[Workflow] Extraction complete. Creating inquiry...`);
        const inquiryRes = await client.query(
            `INSERT INTO public.inquiries (
                customer_id, origin_city, origin_code, destination_city, destination_code,
                departure_date, return_date, trip_type, passengers_adult, passengers_child,
                passengers_infant, travel_class, budget_max, special_requests, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'searching')
            RETURNING id`,
            [
                customerId, extraction.origin_city, extraction.origin_code,
                extraction.destination_city, extraction.destination_code,
                extraction.departure_date, extraction.return_date, extraction.trip_type,
                extraction.passengers_adult, extraction.passengers_child, extraction.passengers_infant,
                extraction.travel_class, extraction.budget_max, extraction.special_requests
            ]
        );

        const inquiryId = inquiryRes.rows[0].id;

        const confirmationMsg = `Perfect! Searching for the best *${extraction.origin_city} to ${extraction.destination_city}* flights for you. ✈️\n\nI'll have options ready for you in a few minutes.`;
        await sendWhatsAppMessage(phone, confirmationMsg);

        // Save to conversations table
        await client.query(
            `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel) 
             VALUES ($1, $2, 'outbound', $3, 'text', 'customer_bot')`,
            [customerId, inquiryId, confirmationMsg]
        );

        await client.query('COMMIT');

        // NODE 8 & 9: Downstream triggers
        const { broadcastInquiry } = require('./supplier-broadcaster');
        const { searchPortals } = require('./portal-searcher');
        console.log(`[Workflow] Triggering search workflows for Inquiry ID: ${inquiryId}`);

        // Background triggers
        broadcastInquiry(inquiryId).catch(err => console.error("[Workflow] Broadcast failed:", err));
        searchPortals(inquiryId).catch(err => console.error("[Workflow] Portal search failed:", err));

        // NODE 1: Quote Compiler Timer (10-minute window)
        // Persisted in PostgreSQL via pg-boss — survives server restarts.
        const waitTime = process.env.NODE_ENV === 'test' ? 30000 : 600000;
        console.log(`[Workflow] Scheduling Quote Compiler for Inquiry ID: ${inquiryId} in ${waitTime / 1000}s`);
        await scheduleQuoteCompilation(inquiryId, waitTime);

        return { status: 'searching', inquiry_id: inquiryId };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[Workflow] Critical error:`, error.message);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { handleCustomerMessage };
