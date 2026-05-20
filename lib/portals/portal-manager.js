'use strict';

const puppeteer = require('puppeteer');   // standard puppeteer — matches discover-selectors.js
const path      = require('path');
const fs        = require('fs');
const db        = require('../db/connection');

const { AirPeaceAdapter } = require('./adapters/airpeace-adapter');
const { ArikAirAdapter }  = require('./adapters/arikair-adapter');
const { IbomAirAdapter }  = require('./adapters/ibomair-adapter');

// ─── Portal registry ──────────────────────────────────────────────────────────
// Each portal gets its OWN browser + userDataDir so cf_clearance cookies are
// stored per-domain. This mirrors what discover-selectors.js did on 2026-05-19,
// which successfully opened all three portals.

const PORTAL_CONFIGS = [
    { name: 'airpeace', label: 'Air Peace', AdapterClass: AirPeaceAdapter },
    { name: 'arik',     label: 'Arik Air',  AdapterClass: ArikAirAdapter  },
    { name: 'ibom',     label: 'Ibom Air',  AdapterClass: IbomAirAdapter  },
];

const UA           = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const VIEWPORT     = { width: 1366, height: 768 };
const SESSIONS_ROOT = path.join(__dirname, '../../browser-sessions');

// ─── PortalManager ────────────────────────────────────────────────────────────

class PortalManager {
    constructor() {
        /** @type {Map<string, import('puppeteer').Browser>} */
        this.browsers      = new Map();
        /** @type {Map<string,'active'|'error'|'unknown'>} */
        this.sessionStatus = new Map();
        this.initialized   = false;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async initialize() {
        if (this.initialized) return;

        // Launch one browser per portal sequentially — one Cloudflare challenge
        // at a time, reusing the existing browser-sessions/{name} cookie stores
        // from the May 19 discovery run.
        for (const config of PORTAL_CONFIGS) {
            await this._launchPortal(config);
        }

        this.initialized = true;
        const ready = [...this.sessionStatus.values()].filter(s => s === 'active').length;
        console.log(`[PortalManager] Ready — ${ready}/${PORTAL_CONFIGS.length} portal(s) online.`);
    }

    async shutdown() {
        for (const [name, browser] of this.browsers) {
            await browser.close().catch(() => {});
            console.log(`[PortalManager] ${name}: browser closed.`);
        }
        this.browsers.clear();
        this.initialized = false;
        console.log('[PortalManager] All browsers closed.');
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    async search({ origin, destination, date, passengers = 1, classType = 'economy', inquiryId }) {
        if (!this.initialized) {
            console.warn('[PortalManager] Not initialized — call initialize() first.');
            return [];
        }

        console.log(`\n[PortalManager] Searching ${origin}→${destination} on ${date} (${passengers} pax)`);

        const settled = await Promise.allSettled(
            PORTAL_CONFIGS.map(config =>
                this._searchOne(config, { origin, destination, date, passengers, classType, inquiryId })
            )
        );

        const results = settled
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value);

        console.log(`[PortalManager] Combined: ${results.length} flight(s)`);
        return results;
    }

    // ─── Session health ───────────────────────────────────────────────────────

    async checkSessionHealth() {
        console.log('[PortalManager] Running session health check...');
        for (const config of PORTAL_CONFIGS) {
            if (!this._isBrowserAlive(config.name)) {
                console.warn(`[PortalManager] ${config.name}: browser dead — relaunching...`);
                await this._launchPortal(config);
            } else {
                // Quick check: open a page and see if the form appears
                await this._prewarm(config);
            }
        }
        const results = Object.fromEntries(this.sessionStatus);
        console.log('[PortalManager] Health check results:', results);
        return results;
    }

    getStatus() {
        const out = {};
        for (const c of PORTAL_CONFIGS) {
            out[c.name] = {
                label:   c.label,
                enabled: true,
                session: this.sessionStatus.get(c.name) || 'not_initialized',
            };
        }
        return out;
    }

    // ─── Private ──────────────────────────────────────────────────────────────

    /** Launch a browser for one portal and pre-warm it. */
    async _launchPortal(config) {
        this.sessionStatus.set(config.name, 'unknown');

        const userDataDir = path.join(SESSIONS_ROOT, config.name);
        fs.mkdirSync(userDataDir, { recursive: true });

        try {
            console.log(`[PortalManager] Launching browser for ${config.name}...`);
            const browser = await puppeteer.launch({
                headless: false,
                userDataDir,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--start-maximized',
                ],
                ignoreDefaultArgs: ['--enable-automation'],
                defaultViewport: VIEWPORT,
            });

            this.browsers.set(config.name, browser);
            await this._prewarm(config);

        } catch (err) {
            console.error(`[PortalManager] ${config.name}: launch failed — ${err.message}`);
            this.sessionStatus.set(config.name, 'error');
        }
    }

    /** Open one page, check the search form appears, close the page. */
    async _prewarm(config) {
        let page = null;
        try {
            page = await this._newPage(config.name);
            const adapter = new config.AdapterClass(page);
            console.log(`[PortalManager] Pre-warming ${config.name} (up to 90s for Cloudflare)...`);
            const ok = await adapter.isLoggedIn(90000);
            this.sessionStatus.set(config.name, ok ? 'active' : 'error');
            if (ok) console.log(`[PortalManager] ${config.name}: ready`);
            else    console.warn(`[PortalManager] ${config.name}: search form not found`);
        } catch (err) {
            console.error(`[PortalManager] ${config.name}: pre-warm error — ${err.message}`);
            this.sessionStatus.set(config.name, 'error');
        } finally {
            if (page) await page.close().catch(() => {});
        }
    }

    /** Open a fresh page in the portal's browser, run the adapter search, close the page. */
    async _searchOne(config, params) {
        let page = null;
        try {
            // Restart browser if it died
            if (!this._isBrowserAlive(config.name)) {
                console.warn(`[PortalManager] ${config.name}: browser dead — relaunching before search...`);
                await this._launchPortal(config);
            }

            page = await this._newPage(config.name);
            const adapter = new config.AdapterClass(page);
            const results = await adapter.search(params);
            this.sessionStatus.set(config.name, 'active');
            await this._log(config.name, 'search_success', `${results.length} result(s)`, params.inquiryId);
            return results;
        } catch (err) {
            console.error(`[PortalManager] ${config.name} search failed: ${err.message}`);
            this.sessionStatus.set(config.name, 'error');
            await this._log(config.name, 'search_error', err.message, params.inquiryId);
            return [];
        } finally {
            if (page) await page.close().catch(() => {});
        }
    }

    async _newPage(portalName) {
        const browser = this.browsers.get(portalName);
        const page    = await browser.newPage();
        await page.setUserAgent(UA);
        await page.setViewport(VIEWPORT);
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        return page;
    }

    _isBrowserAlive(portalName) {
        const browser = this.browsers.get(portalName);
        try {
            return !!(browser && browser.connected);
        } catch {
            return false;
        }
    }

    async _log(portalName, eventType, message, inquiryId = null) {
        try {
            await db.query(
                `INSERT INTO public.portal_search_logs (portal_name, event_type, message, inquiry_id)
                 VALUES ($1, $2, $3, $4)`,
                [portalName, eventType, message, inquiryId || null]
            );
        } catch {
            console.log(`[PortalLog] ${portalName} | ${eventType} | ${message}`);
        }
    }
}

const portalManager = new PortalManager();
module.exports = { portalManager, PortalManager };
