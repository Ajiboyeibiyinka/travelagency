'use strict';

const axios = require('axios');
require('dotenv').config();

/**
 * Push a real-time event to the Next.js dashboard via its internal webhook.
 * The dashboard receives this and emits a Socket.io event to all connected agents.
 *
 * @param {string} event  - Event name (e.g. 'new_request', 'search_complete')
 * @param {object} data   - Payload to send to the dashboard
 */
async function notifyDashboard(event, data) {
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3001';
    const secret       = process.env.INTERNAL_WEBHOOK_SECRET;

    if (!secret) {
        console.warn('[DashboardNotify] INTERNAL_WEBHOOK_SECRET not set — skipping notification.');
        return;
    }

    try {
        await axios.post(
            `${dashboardUrl}/api/webhooks/notify`,
            { type: event, data },
            {
                headers: { 'x-internal-secret': secret },
                timeout: 5000,
            }
        );
        console.log(`[DashboardNotify] Sent "${event}" to dashboard.`);
    } catch (err) {
        // Non-fatal — dashboard may not be running in dev
        console.warn(`[DashboardNotify] Failed to notify dashboard: ${err.message}`);
    }
}

module.exports = { notifyDashboard };
