const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { extractFlightDetails } = require('./lib/ai/flight-detail-extractor');
const { extractSupplierQuotes } = require('./lib/ai/supplier-quote-extractor');
const { generateCustomerResponse } = require('./lib/ai/customer-response-generator');
const { handleCustomerMessage } = require('./lib/flows/customer-inquiry-handler');
const { handleGroupMessage } = require('./lib/flows/supplier-response-listener');
const { startScheduler, stopScheduler } = require('./lib/jobs/scheduler');
const { portalManager } = require('./lib/portals/portal-manager');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(morgan('dev'));
// Raw body needed for WhatsApp signature verification — must come before bodyParser
app.use('/webhook/whatsapp', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(express.static('public'));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute window
    max: 30,               // max 30 requests per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,               // webhooks can be chattier (many messages per minute)
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests.' },
});

app.use('/api/', apiLimiter);
app.use('/webhook/', webhookLimiter);

// ─── Auth: API Key middleware for /api/* ──────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!process.env.API_KEY) {
        // No key configured — skip auth (dev mode)
        return next();
    }
    if (!key || key !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key header' });
    }
    next();
}

app.use('/api/', requireApiKey);

// ─── Auth: WhatsApp webhook signature verification ────────────────────────────
function verifyWhatsAppSignature(req, res, next) {
    if (!process.env.WA_WEBHOOK_SECRET) {
        // Secret not configured — skip verification (dev mode)
        // Parse the raw body for downstream handlers
        if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString());
        return next();
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        return res.status(401).json({ error: 'Missing X-Hub-Signature-256 header' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.WA_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        console.warn('[Webhook] Invalid WhatsApp signature — request rejected');
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    req.body = JSON.parse(rawBody.toString());
    next();
}

// ─── Auth: Evolution API webhook secret ──────────────────────────────────────
function verifyEvolutionSecret(req, res, next) {
    if (!process.env.EVO_WEBHOOK_SECRET) {
        return next(); // dev mode
    }
    const key = req.headers['apikey'] || req.headers['x-api-key'];
    if (!key || key !== process.env.EVO_WEBHOOK_SECRET) {
        console.warn('[Evolution Webhook] Invalid secret — request rejected');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── API: Portal status (dashboard polling endpoint) ─────────────────────────
app.get('/api/portal-status', requireApiKey, (req, res) => {
    res.json(portalManager.getStatus());
});

// ─── API: Trigger manual session health check ─────────────────────────────────
app.post('/api/portal-status/check', requireApiKey, async (req, res) => {
    try {
        const results = await portalManager.checkSessionHealth();
        res.json({ checked: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── API: Extract Flight Inquiry Details ──────────────────────────────────────
app.post('/api/extract/inquiry', async (req, res) => {
    const { message, customerId, saveToDb } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const result = await extractFlightDetails(message, {
            saveToDb: saveToDb === true,
            customerId: customerId || null,
            source: 'web_test'
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Extract Supplier Quotes ─────────────────────────────────────────────
app.post('/api/extract/quotes', async (req, res) => {
    const { message, groupName, supplierName, inquiryId, saveToDb } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const quotes = await extractSupplierQuotes(message, {
            groupName: groupName || 'Manual Test Group',
            supplierName: supplierName || 'Manual Tester',
            saveToDb: saveToDb === true,
            inquiryId: inquiryId || null
        });
        res.json({ quotes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Generate Customer Response ─────────────────────────────────────────
app.post('/api/generate/response', async (req, res) => {
    const { customerInfo, quotes } = req.body;

    if (!customerInfo || !quotes || !Array.isArray(quotes)) {
        return res.status(400).json({ error: 'customerInfo and quotes array are required' });
    }

    try {
        const result = await generateCustomerResponse(customerInfo, quotes);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Webhook: Evolution API (ALL messages — customers + supplier groups) ──────
//
// Evolution API sends a single webhook for every message on the instance.
// We route based on the JID suffix:
//   @s.whatsapp.net  → individual DM  → customer inquiry handler
//   @g.us            → group message  → supplier quote listener
//
app.post('/webhook/evolution', verifyEvolutionSecret, async (req, res) => {
    const body = req.body;

    // Evolution API wraps everything inside a "data" object
    const event = body.event;
    const data  = body.data;

    // Only care about incoming messages
    if (event !== 'messages.upsert' || !data) {
        return res.json({ status: 'ignored', reason: `event=${event}` });
    }

    const key     = data.key || {};
    const fromMe  = key.fromMe === true;
    const jid     = key.remoteJid || '';
    const msgId   = key.id || '';
    const sender  = data.pushName || key.participant || 'Unknown';

    // Extract plain text from the message object (handles both simple and extended text)
    const msgObj  = data.message || {};
    const text    = msgObj.conversation
        || msgObj.extendedTextMessage?.text
        || msgObj.imageMessage?.caption
        || '';

    if (!text || !jid) {
        return res.json({ status: 'ignored', reason: 'no_text_or_jid' });
    }

    try {
        if (jid.endsWith('@g.us')) {
            // ── Supplier group message ───────────────────────────────────────
            const result = await handleGroupMessage({
                groupJid:     jid,
                requesterJid: key.participant || jid,
                messageText:  text,
                isFromMe:     fromMe,
            });
            return res.json(result);

        } else {
            // ── Customer DM ──────────────────────────────────────────────────
            if (fromMe) return res.json({ status: 'ignored', reason: 'own_message' });

            const phone = jid.replace('@s.whatsapp.net', '');
            const result = await handleCustomerMessage({
                phone,
                name:         sender,
                message_text: text,
                message_id:   msgId,
            });
            return res.json(result);
        }
    } catch (error) {
        console.error(`[Evolution Webhook Error]`, error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Webhook: WhatsApp Business API (kept for future use / Meta Cloud API) ───
app.post('/webhook/whatsapp', verifyWhatsAppSignature, async (req, res) => {
    const { from, name, text, id } = req.body;
    if (!from || !text) return res.status(400).json({ error: 'from and text are required' });
    try {
        const result = await handleCustomerMessage({ phone: from, name, message_text: text, message_id: id });
        res.json(result);
    } catch (error) {
        console.error(`[WhatsApp Webhook Error]`, error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
    // Start job scheduler (pg-boss)
    await startScheduler();

    // Initialise portal HTTP clients (set PORTALS_ENABLED=false in .env to skip)
    if (process.env.PORTALS_ENABLED !== 'false') {
        portalManager.initialize().catch(err =>
            console.error('[Server] Portal manager failed to initialize:', err.message)
        );
    } else {
        console.log('[PortalManager] Skipped (PORTALS_ENABLED=false).');
    }

    // Session health check every hour
    const SESSION_CHECK_INTERVAL = 60 * 60 * 1000;
    if (process.env.PORTALS_ENABLED !== 'false') {
        setInterval(() => {
            portalManager.checkSessionHealth().catch(err =>
                console.error('[Server] Session health check error:', err.message)
            );
        }, SESSION_CHECK_INTERVAL);
    }

    const server = app.listen(PORT, () => {
        console.log(`\n[v1.3.0] Travel Agency AI Service running at http://localhost:${PORT}`);
        console.log(`- POST /api/extract/inquiry        (requires x-api-key if API_KEY is set)`);
        console.log(`- POST /api/extract/quotes         (requires x-api-key if API_KEY is set)`);
        console.log(`- GET  /api/portal-status          (live portal session status)`);
        console.log(`- POST /api/portal-status/check    (trigger manual session health check)`);
        console.log(`- POST /webhook/evolution          (ALL messages: customers + supplier groups via Evolution API)`);
        console.log(`- POST /webhook/whatsapp           (legacy: Meta Cloud API)\n`);
    });

    // Graceful shutdown — close browsers and job queue cleanly
    const shutdown = async (signal) => {
        console.log(`\n[Server] ${signal} received. Shutting down...`);
        server.close(async () => {
            await Promise.allSettled([
                stopScheduler(),
                portalManager.shutdown(),
            ]);
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
});
