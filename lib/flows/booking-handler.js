const { pool } = require('../db/connection');
const { parseCustomerSelection, extractPassengerDetails } = require('../ai/booking-extractor');
const { sendWhatsAppMessage } = require('../whatsapp/api');
require('dotenv').config();

const NIGERIAN_AIRPORTS = new Set([
    'LOS', 'ABV', 'PHC', 'KAN', 'ENU', 'CBQ', 'QOW', 'BNI',
    'AKR', 'MBI', 'ILR', 'JOS', 'SOC', 'MIU', 'YOL', 'QRW', 'QUO', 'ABB', 'KAD',
]);

function isInternationalFlight(inquiry) {
    return !NIGERIAN_AIRPORTS.has(inquiry.origin_code) || !NIGERIAN_AIRPORTS.has(inquiry.destination_code);
}

function formatPrice(amount) {
    return `NGN ${Number(amount).toLocaleString('en-NG')}`;
}

function formatDate(dateVal) {
    return new Date(dateVal).toLocaleDateString('en-NG', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos',
    });
}

function formatTime(tsVal) {
    if (!tsVal) return 'TBC';
    return new Date(tsVal).toLocaleTimeString('en-NG', {
        hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Lagos',
    });
}

/**
 * Main entry point: routes a customer message to the correct booking node
 * based on the current inquiry status.
 *
 * @param {object} payload - { phone, name, message_text, message_id }
 * @param {object} inquiry - Full inquiry row (joined with customer_name, customer_phone)
 */
async function handleBookingFlow(payload, inquiry) {
    console.log(`\n[BookingHandler] Inquiry ${inquiry.id} — status: ${inquiry.status}`);

    if (inquiry.status === 'quotes_ready') {
        return handleSelectionReply(payload, inquiry);
    }
    if (inquiry.status === 'customer_confirmed') {
        return handlePassengerReply(payload, inquiry);
    }
    if (inquiry.status === 'payment') {
        return handlePaymentStatus(payload, inquiry);
    }

    return { status: 'no_action', reason: `Unhandled booking status: ${inquiry.status}` };
}

// ─── Node 1 + 2: Parse Selection & Confirm ────────────────────────────────────

async function handleSelectionReply(payload, inquiry) {
    const { phone, message_text } = payload;

    // 1. Fetch ranked quotes in the order the customer was shown
    const rankedQuotes = await fetchRankedQuotes(inquiry);
    if (rankedQuotes.length === 0) {
        const noQuotesMsg = `Sorry, I couldn't find any flight options for this inquiry. Please contact our team directly for assistance.`;
        await sendWhatsAppMessage(phone, noQuotesMsg);
        return { status: 'error', reason: 'no_quotes_available' };
    }

    // 2. AI: parse which option the customer chose
    const selection = await parseCustomerSelection(message_text, rankedQuotes);

    if (!selection.selected_rank || selection.confidence < 50) {
        const clarifyMsg = buildClarificationMessage(rankedQuotes, selection.reason);
        await sendWhatsAppMessage(phone, clarifyMsg);
        return { status: 'awaiting_selection', reason: selection.reason };
    }

    const selectedQuote = rankedQuotes[selection.selected_rank - 1];
    if (!selectedQuote) {
        const invalidMsg = `I couldn't match that to one of the options. Please reply with just the number — *1*, *2*, or *3*.`;
        await sendWhatsAppMessage(phone, invalidMsg);
        return { status: 'invalid_selection' };
    }

    // 3. Create booking record & mark quote as selected
    const totalPassengers = (inquiry.passengers_adult || 1) + (inquiry.passengers_child || 0) + (inquiry.passengers_infant || 0);
    const totalAmount = Number(selectedQuote.price_amount) * totalPassengers;
    const isInternational = isInternationalFlight(inquiry);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const isSupplierQuote = selectedQuote.source === 'whatsapp_group';
        const bookingRes = await client.query(
            `INSERT INTO public.bookings (
                inquiry_id, customer_id,
                selected_quote_id, selected_portal_quote_id,
                total_amount, payment_status, passenger_details, status
            ) VALUES ($1, $2, $3, $4, $5, 'pending', '[]', 'confirmed')
            RETURNING id`,
            [
                inquiry.id,
                inquiry.customer_id,
                isSupplierQuote ? selectedQuote.id : null,
                isSupplierQuote ? null : selectedQuote.id,
                totalAmount,
            ]
        );
        const booking = bookingRes.rows[0];

        if (isSupplierQuote) {
            await client.query(
                "UPDATE public.supplier_quotes SET is_selected = true WHERE id = $1",
                [selectedQuote.id]
            );
        }

        await client.query(
            "UPDATE public.inquiries SET status = 'customer_confirmed', updated_at = NOW() WHERE id = $1",
            [inquiry.id]
        );

        // 4. Send confirmation message + ask for first passenger's details
        const confirmMsg = buildSelectionConfirmationMessage(selectedQuote, inquiry, totalPassengers, isInternational);
        await sendWhatsAppMessage(phone, confirmMsg);

        await client.query(
            `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel)
             VALUES ($1, $2, 'outbound', $3, 'text', 'customer_bot')`,
            [inquiry.customer_id, inquiry.id, confirmMsg]
        );

        await client.query('COMMIT');
        console.log(`[BookingHandler] Booking created: ${booking.id} | Amount: ${formatPrice(totalAmount)}`);
        return { status: 'booking_created', booking_id: booking.id, amount: totalAmount };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[BookingHandler] Error creating booking:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// ─── Node 3: Collect Passenger Details (Loop) ─────────────────────────────────

async function handlePassengerReply(payload, inquiry) {
    const { phone, message_text } = payload;

    // Fetch active booking
    const bookingRes = await pool.query(
        `SELECT * FROM public.bookings
         WHERE inquiry_id = $1 AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 1`,
        [inquiry.id]
    );

    if (bookingRes.rows.length === 0) {
        // Booking not found — customer may have messaged before booking was created
        console.warn('[BookingHandler] No confirmed booking found for passenger reply. Re-routing to selection.');
        return handleSelectionReply(payload, inquiry);
    }

    const booking = bookingRes.rows[0];
    const totalPassengers = (inquiry.passengers_adult || 1) + (inquiry.passengers_child || 0) + (inquiry.passengers_infant || 0);
    const isInternational = isInternationalFlight(inquiry);

    // Count passengers already saved
    const countRes = await pool.query(
        "SELECT COUNT(*) FROM public.passengers WHERE booking_id = $1",
        [booking.id]
    );
    const savedCount = parseInt(countRes.rows[0].count);

    if (savedCount >= totalPassengers) {
        // All passengers already collected — resend payment instructions (idempotent)
        await sendPaymentInstructions(phone, inquiry, booking);
        return { status: 'already_complete' };
    }

    const currentPassengerNum = savedCount + 1;

    // AI: extract passenger details
    const passenger = await extractPassengerDetails(message_text, {
        isInternational,
        passengerNumber: currentPassengerNum,
        totalPassengers,
    });

    // Validate: check for critical missing fields
    const missing = passenger.missing_fields || [];
    if (missing.length > 0 || !passenger.full_name || !passenger.date_of_birth) {
        const retryMsg = buildPassengerRetryMessage(currentPassengerNum, missing, isInternational);
        await sendWhatsAppMessage(phone, retryMsg);
        return { status: 'passenger_details_incomplete', missing };
    }

    // Save passenger to DB
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO public.passengers (
                booking_id, full_name, title, date_of_birth, nationality,
                passport_number, passport_expiry, phone, passenger_type
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                booking.id,
                passenger.full_name,
                passenger.title || 'Mr',
                passenger.date_of_birth,
                passenger.nationality || 'Nigerian',
                passenger.passport_number || null,
                passenger.passport_expiry || null,
                passenger.phone || null,
                passenger.passenger_type || 'adult',
            ]
        );

        const newSavedCount = savedCount + 1;

        if (newSavedCount < totalPassengers) {
            // More passengers to collect
            const nextMsg = buildNextPassengerRequestMessage(currentPassengerNum, newSavedCount + 1, isInternational);
            await sendWhatsAppMessage(phone, nextMsg);
            await client.query(
                `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel)
                 VALUES ($1, $2, 'outbound', $3, 'text', 'customer_bot')`,
                [inquiry.customer_id, inquiry.id, nextMsg]
            );
            await client.query('COMMIT');
            console.log(`[BookingHandler] Passenger ${currentPassengerNum} saved. Requesting passenger ${newSavedCount + 1}.`);
            return { status: 'passenger_saved', next_passenger: newSavedCount + 1 };
        }

        // All passengers collected — proceed to payment & handoff
        await client.query('COMMIT');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[BookingHandler] Error saving passenger:', error.message);
        throw error;
    } finally {
        client.release();
    }

    // Nodes 4–7: finalize
    await finalizeBooking(phone, inquiry, booking);
    return { status: 'booking_complete', booking_id: booking.id };
}

// ─── Nodes 4–7: Create Record, Payment Instructions, Notify Staff, Hand Off ───

async function finalizeBooking(phone, inquiry, booking) {
    console.log(`[BookingHandler] Finalizing booking ${booking.id} — sending payment instructions.`);

    // Node 5: Send payment instructions to customer
    await sendPaymentInstructions(phone, inquiry, booking);

    // Node 6: Notify staff
    await notifyStaff(inquiry, booking);

    // Node 7: Update inquiry status → 'payment' (hand off to human agent)
    await pool.query(
        "UPDATE public.inquiries SET status = 'payment', updated_at = NOW() WHERE id = $1",
        [inquiry.id]
    );

    console.log(`[BookingHandler] Inquiry ${inquiry.id} handed off to human agent (status: payment).`);
}

// ─── Payment status handler (already handed off) ─────────────────────────────

async function handlePaymentStatus(payload, inquiry) {
    const { phone } = payload;
    const msg = `Your booking is being processed by our team. Please make sure you've sent your payment proof here, and we'll issue your ticket shortly.\n\nIf you haven't paid yet, please make payment to the bank details we sent you. Need help? Reply *agent* and a team member will assist you.`;
    await sendWhatsAppMessage(phone, msg);
    return { status: 'payment_pending_human' };
}

// ─── Helpers: Fetch ranked quotes ────────────────────────────────────────────

async function fetchRankedQuotes(inquiry) {
    // Use AI-ranked order if persisted by quote-compiler
    if (inquiry.ranked_quote_ids && inquiry.ranked_quote_ids.length > 0) {
        const ranked = [];
        const sortedRanks = [...inquiry.ranked_quote_ids].sort((a, b) => a.rank - b.rank);

        for (const entry of sortedRanks) {
            let quoteRes;
            if (entry.source === 'whatsapp_group') {
                quoteRes = await pool.query(
                    "SELECT *, 'whatsapp_group' as source FROM public.supplier_quotes WHERE id = $1",
                    [entry.quote_id]
                );
            } else {
                quoteRes = await pool.query(
                    "SELECT *, 'airline_portal' as source FROM public.portal_quotes WHERE id = $1",
                    [entry.quote_id]
                );
            }
            if (quoteRes.rows.length > 0) {
                ranked.push(quoteRes.rows[0]);
            }
        }
        return ranked;
    }

    // Fallback: sort by price ASC (matches Claude's primary ranking rule)
    console.warn('[BookingHandler] ranked_quote_ids not found — falling back to price sort.');
    const supplierRes = await pool.query(
        "SELECT *, 'whatsapp_group' as source FROM public.supplier_quotes WHERE inquiry_id = $1 ORDER BY price_amount ASC LIMIT 5",
        [inquiry.id]
    );
    const portalRes = await pool.query(
        "SELECT *, 'airline_portal' as source FROM public.portal_quotes WHERE inquiry_id = $1 ORDER BY price_amount ASC LIMIT 5",
        [inquiry.id]
    );
    const all = [...supplierRes.rows, ...portalRes.rows].sort((a, b) => a.price_amount - b.price_amount);
    return all.slice(0, 5);
}

// ─── Helpers: Message builders ────────────────────────────────────────────────

function buildClarificationMessage(rankedQuotes, reason) {
    const options = rankedQuotes.map((q, i) =>
        `*${i + 1}.* ${q.airline || 'Unknown'} — ${formatTime(q.departure_time)} — ${formatPrice(q.price_amount)}`
    ).join('\n');
    return `I couldn't quite catch which option you'd like${reason ? ` (${reason})` : ''}.\n\nPlease reply with just the number of your choice:\n\n${options}`;
}

function buildSelectionConfirmationMessage(quote, inquiry, totalPassengers, isInternational) {
    const passengerWord = totalPassengers === 1 ? 'passenger' : 'passengers';
    const intlExtra = isInternational
        ? '\n- Passport number\n- Passport expiry date\n- Nationality'
        : '';

    return `Great choice! ✈️ You selected *${quote.airline || 'the flight'}* at *${formatPrice(quote.price_amount)}* per person.\n\n`
        + `*Flight:* ${inquiry.origin_city} → ${inquiry.destination_city}\n`
        + `*Date:* ${formatDate(inquiry.departure_date)}\n`
        + `*Departure:* ${formatTime(quote.departure_time)}\n`
        + `*Total for ${totalPassengers} ${passengerWord}:* ${formatPrice(Number(quote.price_amount) * totalPassengers)}\n\n`
        + `To proceed, I need the following for each passenger:\n`
        + `- Full name (as on ID/passport)\n`
        + `- Date of birth\n`
        + `- Phone number${intlExtra}\n\n`
        + `Please send details for *Passenger 1* now.`;
}

function buildPassengerRetryMessage(passengerNum, missingFields, isInternational) {
    const fieldLabels = {
        full_name: 'Full name (as on ID/passport)',
        date_of_birth: 'Date of birth',
        nationality: 'Nationality',
        passport_number: 'Passport number',
        passport_expiry: 'Passport expiry date',
    };
    const missingList = missingFields
        .map(f => `- ${fieldLabels[f] || f}`)
        .join('\n');

    return `I'm still missing some required details for *Passenger ${passengerNum}*:\n\n${missingList}\n\nPlease resend the complete details for this passenger.`;
}

function buildNextPassengerRequestMessage(justSavedNum, nextNum, isInternational) {
    const intlExtra = isInternational ? '\n- Passport number and expiry date\n- Nationality' : '';
    return `Passenger ${justSavedNum} saved! ✓\n\nPlease send details for *Passenger ${nextNum}*:\n`
        + `- Full name (as on ID/passport)\n`
        + `- Date of birth\n`
        + `- Phone number${intlExtra}`;
}

// ─── Helpers: Payment instructions ───────────────────────────────────────────

async function sendPaymentInstructions(phone, inquiry, booking) {
    // Fetch passengers for the summary
    const passengersRes = await pool.query(
        "SELECT full_name, title, passenger_type FROM public.passengers WHERE booking_id = $1 ORDER BY created_at",
        [booking.id]
    );
    const passengers = passengersRes.rows;

    // Fetch selected quote details
    let quote = null;
    if (booking.selected_quote_id) {
        const q = await pool.query("SELECT * FROM public.supplier_quotes WHERE id = $1", [booking.selected_quote_id]);
        if (q.rows.length) quote = q.rows[0];
    } else if (booking.selected_portal_quote_id) {
        const q = await pool.query("SELECT * FROM public.portal_quotes WHERE id = $1", [booking.selected_portal_quote_id]);
        if (q.rows.length) quote = q.rows[0];
    }

    const passengerList = passengers.length > 0
        ? passengers.map((p, i) => `   ${i + 1}. ${p.title} ${p.full_name}`).join('\n')
        : '   (details saved)';

    const bankName = process.env.PAYMENT_BANK_NAME || 'First Bank Nigeria';
    const accountName = process.env.PAYMENT_ACCOUNT_NAME || 'Travel Agency Ltd';
    const accountNumber = process.env.PAYMENT_ACCOUNT_NUMBER || '0123456789';

    const msg = `Booking Confirmed! 🎉\n\n`
        + `Here's your full summary:\n\n`
        + `✈️ *Flight Details*\n`
        + `Route: ${inquiry.origin_city} → ${inquiry.destination_city}\n`
        + `Date: ${formatDate(inquiry.departure_date)}\n`
        + (quote ? `Airline: ${quote.airline || 'TBC'}\n` : '')
        + (quote ? `Departure: ${formatTime(quote.departure_time)}\n` : '')
        + `Class: ${inquiry.travel_class}\n\n`
        + `👥 *Passengers* (${passengers.length})\n${passengerList}\n\n`
        + `💰 *Total Amount: ${formatPrice(booking.total_amount)}*\n\n`
        + `To complete your booking, please pay to:\n`
        + `*Bank:* ${bankName}\n`
        + `*Account Name:* ${accountName}\n`
        + `*Account Number:* ${accountNumber}\n`
        + `*Amount:* ${formatPrice(booking.total_amount)}\n\n`
        + `Send your payment proof here and your ticket will be issued shortly. ✓`;

    await sendWhatsAppMessage(phone, msg);

    await pool.query(
        `INSERT INTO public.conversations (customer_id, inquiry_id, direction, message_text, message_type, channel)
         VALUES ($1, $2, 'outbound', $3, 'text', 'customer_bot')`,
        [inquiry.customer_id, inquiry.id, msg]
    );
}

// ─── Helpers: Staff notification ──────────────────────────────────────────────

async function notifyStaff(inquiry, booking) {
    let staffPhone = process.env.STAFF_ALERT_PHONE;
    if (!staffPhone) {
        console.log('[BookingHandler] STAFF_ALERT_PHONE not set — skipping staff notification.');
        return;
    }

    // Check if there's an assigned agent with their own phone
    if (inquiry.assigned_agent_id) {
        const agentRes = await pool.query(
            "SELECT phone FROM public.staff WHERE id = $1 AND is_active = true",
            [inquiry.assigned_agent_id]
        );
        if (agentRes.rows.length > 0) staffPhone = agentRes.rows[0].phone;
    }

    const totalPassengers = (inquiry.passengers_adult || 1) + (inquiry.passengers_child || 0) + (inquiry.passengers_infant || 0);

    const alertMsg = `🔔 *New Booking — Pending Payment*\n\n`
        + `Customer: ${inquiry.customer_name || 'Unknown'} (${inquiry.customer_phone})\n`
        + `Route: ${inquiry.origin_city} → ${inquiry.destination_city}\n`
        + `Date: ${formatDate(inquiry.departure_date)}\n`
        + `Class: ${inquiry.travel_class}\n`
        + `Passengers: ${totalPassengers}\n`
        + `*Amount: ${formatPrice(booking.total_amount)}*\n\n`
        + `Booking ID: ${booking.id}\n`
        + `Inquiry ID: ${inquiry.id}\n\n`
        + `Action required: Verify payment and issue ticket in Amadeus/portal.`;

    await sendWhatsAppMessage(staffPhone, alertMsg);
    console.log(`[BookingHandler] Staff alert sent to ${staffPhone}.`);
}

module.exports = { handleBookingFlow };
