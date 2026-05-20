'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getOutcomeDetectorPrompt } = require('./prompts');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Classify whether an incoming group message is an acceptance or rejection
 * of an offer we previously posted.
 *
 * @param {string} messageText      - The new message from the group
 * @param {string} ourOffer         - The response_message we posted
 * @param {boolean} isFromRequester - True if senderJid matches original requester_jid
 * @returns {Promise<{ outcome: 'won'|'lost'|null, confidence: number, reason: string }>}
 */
async function detectOutcome(messageText, ourOffer, isFromRequester) {
    const systemPrompt = getOutcomeDetectorPrompt(ourOffer, isFromRequester);

    const response = await anthropic.messages.create({
        model:      'claude-3-5-sonnet-latest',
        max_tokens: 200,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: messageText }],
    });

    const raw = response.content[0].text.trim()
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '');

    const parsed = JSON.parse(raw);

    // Enforce the confidence gate — don't trust the model if it returns low confidence
    if (parsed.confidence < 65) {
        parsed.outcome = null;
    }

    return {
        outcome:    parsed.outcome ?? null,
        confidence: parsed.confidence ?? 0,
        reason:     parsed.reason ?? '',
    };
}

module.exports = { detectOutcome };
