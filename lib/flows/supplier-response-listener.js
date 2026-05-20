'use strict';

const db                  = require('../db/connection');
const { detectGroupRequest } = require('../ai/group-request-detector');
const { detectOutcome }   = require('../ai/outcome-detector');
const { notifyDashboard } = require('../utils/dashboard-notify');

/**
 * Handle an incoming message from a monitored supplier WhatsApp group.
 *
 * Option B flow:
 *   Step A — Detect new flight request → search portals → notify dashboard
 *   Step B — Detect win/loss reply for a posted offer → update DB → notify dashboard
 *
 * @param {object} payload
 * @param {string}  payload.groupJid      - WhatsApp group JID (@g.us)
 * @param {string}  payload.requesterJid  - Sender's JID (@s.whatsapp.net)
 * @param {string}  payload.messageText   - Raw message text
 * @param {boolean} payload.isFromMe      - True if sent by our own WhatsApp number
 */
async function handleGroupMessage(payload) {
    const { groupJid, requesterJid, messageText, isFromMe } = payload;

    // Never process our own outgoing messages
    if (isFromMe) {
        return { status: 'ignored', reason: 'own_message' };
    }

    if (!messageText || messageText.trim().length < 3) {
        return { status: 'ignored', reason: 'empty_message' };
    }

    // ── Step A: Check if this is a new flight REQUEST ─────────────────────
    const inquiry = await detectGroupRequest(messageText, groupJid, requesterJid);

    if (inquiry) {
        // New request detected — kick off portal search pipeline
        const { runPortalSearch } = require('./portal-search-pipeline');
        runPortalSearch(inquiry).catch(err =>
            console.error(`[GroupHandler] Pipeline error for inquiry ${inquiry.id}:`, err.message)
        );
        return { status: 'processing', inquiry_id: inquiry.id };
    }

    // ── Step B: Check for win/loss on a previously posted offer ───────────
    const posted = await findPostedInquiry(groupJid);

    if (!posted) {
        return { status: 'ignored', reason: 'not_a_request' };
    }

    return await resolveOutcome(messageText, posted, requesterJid);
}

/**
 * Find the most recent 'posted' inquiry in a given group that has a pending
 * group_response (i.e. we sent an offer but haven't heard back yet).
 *
 * @param {string} groupJid
 * @returns {Promise<object|null>} Combined inquiry + group_response row
 */
async function findPostedInquiry(groupJid) {
    const result = await db.query(
        `SELECT
            i.id,
            i.group_jid,
            i.requester_jid,
            i.origin_code,
            i.destination_code,
            i.status,
            gr.id          AS gr_id,
            gr.response_message
         FROM inquiries i
         JOIN group_responses gr
           ON gr.inquiry_id = i.id AND gr.outcome = 'unknown'
         WHERE i.group_jid = $1
           AND i.status    = 'posted'
         ORDER BY i.updated_at DESC
         LIMIT 1`,
        [groupJid]
    );
    return result.rows[0] || null;
}

/**
 * Run outcome detection for a message and, if conclusive, update DB + notify dashboard.
 *
 * @param {string} messageText
 * @param {object} posted        - Combined inquiry + group_response row
 * @param {string} senderJid
 */
async function resolveOutcome(messageText, posted, senderJid) {
    if (!posted.response_message) {
        return { status: 'ignored', reason: 'no_offer_text' };
    }

    const isFromRequester = !!(posted.requester_jid && senderJid &&
        senderJid === posted.requester_jid);

    let result;
    try {
        result = await detectOutcome(messageText, posted.response_message, isFromRequester);
    } catch (err) {
        console.error('[OutcomeDetector] Claude call failed:', err.message);
        return { status: 'ignored', reason: 'outcome_detection_error' };
    }

    if (!result.outcome) {
        console.log(`[OutcomeDetector] Neutral message in ${posted.group_jid} — confidence ${result.confidence}%: ${result.reason}`);
        return { status: 'ignored', reason: 'neutral_message' };
    }

    const newStatus = result.outcome === 'won' ? 'won' : 'lost';

    // Update the group_response outcome
    await db.query(
        `UPDATE group_responses SET outcome = $1 WHERE id = $2`,
        [result.outcome, posted.gr_id]
    );

    // Update inquiry status
    await db.query(
        `UPDATE inquiries SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, posted.id]
    );

    console.log(`[OutcomeDetector] ✓ Inquiry ${posted.id} → ${newStatus} (${result.confidence}% confidence)`);

    // Notify dashboard so agents see the real-time update
    await notifyDashboard('workflow_update', {
        event_subtype: 'outcome_detected',
        inquiry_id:    posted.id,
        outcome:       result.outcome,
        confidence:    result.confidence,
        reason:        result.reason,
        route:         `${posted.origin_code} → ${posted.destination_code}`,
    });

    return {
        status:     result.outcome,
        inquiry_id: posted.id,
        confidence: result.confidence,
        reason:     result.reason,
    };
}

module.exports = { handleGroupMessage };
