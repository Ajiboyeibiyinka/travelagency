'use strict';

/**
 * BasePortalAdapter
 *
 * Abstract base class for all airline portal adapters.
 * Provides shared helpers (human-like delays, safe interaction, date formatting)
 * and defines the interface every adapter must implement.
 *
 * To add a new portal:
 *   1. Create lib/portals/adapters/myairline-adapter.js
 *   2. extend BasePortalAdapter
 *   3. Implement: isLoggedIn(), navigateToSearchPage(), fillSearchForm(), extractResults()
 *   4. Register in portal-manager.js PORTAL_CONFIGS array
 */
class BasePortalAdapter {
    /**
     * @param {import('puppeteer').Page} page - Puppeteer page instance
     * @param {string} portalName - Identifier matching portal_quotes.portal_name constraint
     */
    constructor(page, portalName) {
        this.page = page;
        this.portalName = portalName;
    }

    // ─── Abstract methods — must be implemented by each portal adapter ──────────

    /**
     * Check whether the current browser session is authenticated.
     * Inspect the DOM for logged-in indicators (user avatar, sign-out link, etc.)
     * @returns {Promise<boolean>}
     */
    async isLoggedIn() {
        throw new Error(`[${this.portalName}] isLoggedIn() not implemented`);
    }

    /**
     * Navigate to the flight search page.
     * @returns {Promise<void>}
     */
    async navigateToSearchPage() {
        throw new Error(`[${this.portalName}] navigateToSearchPage() not implemented`);
    }

    /**
     * Fill in all search form fields and submit.
     * @param {object} params
     * @param {string} params.origin      - IATA origin code (e.g. 'LOS')
     * @param {string} params.destination - IATA destination code (e.g. 'ABV')
     * @param {string} params.date        - Departure date YYYY-MM-DD
     * @param {number} params.passengers  - Total passenger count
     * @param {string} params.classType   - 'economy' | 'business' | 'first'
     * @returns {Promise<void>}
     */
    async fillSearchForm(params) {
        throw new Error(`[${this.portalName}] fillSearchForm() not implemented`);
    }

    /**
     * Parse the results page and return standardized flight objects.
     * Must be called after fillSearchForm() has submitted and results have loaded.
     * @returns {Promise<Array<StandardizedFlight>>}
     */
    async extractResults() {
        throw new Error(`[${this.portalName}] extractResults() not implemented`);
    }

    // ─── Template method — orchestrates the full search flow ────────────────────

    /**
     * Run a complete search: navigate → fill form → extract results.
     * Adapters should NOT override this; override the individual methods above.
     *
     * @param {object} params - Same as fillSearchForm params
     * @returns {Promise<Array<StandardizedFlight>>}
     */
    async search(params) {
        const { origin, destination, date, passengers, classType } = params;
        console.log(`[${this.portalName}] Searching ${origin}→${destination} on ${date} (${passengers} pax, ${classType})`);

        await this.navigateToSearchPage();
        await this.humanDelay(800, 1800);

        await this.fillSearchForm({ origin, destination, date, passengers, classType });
        await this.humanDelay(500, 1200);

        const results = await this.extractResults();
        console.log(`[${this.portalName}] Extracted ${results.length} flight(s)`);
        return results;
    }

    // ─── Human-behaviour helpers ─────────────────────────────────────────────────

    /**
     * Wait for a random interval to mimic human pacing.
     * @param {number} minMs
     * @param {number} maxMs
     */
    async humanDelay(minMs = 500, maxMs = 2000) {
        const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        await new Promise(r => setTimeout(r, ms));
    }

    /**
     * Click an element after verifying it is visible. Adds pre/post delay.
     * @param {string} selector - CSS selector
     * @param {object} [opts]
     * @param {number} [opts.timeout=10000]
     */
    async safeClick(selector, opts = {}) {
        const { timeout = 10000 } = opts;
        await this.page.waitForSelector(selector, { visible: true, timeout });
        await this.humanDelay(150, 500);
        await this.page.click(selector);
        await this.humanDelay(200, 700);
    }

    /**
     * Type into a field with randomised per-character delay to mimic human typing.
     * Optionally clears the field first.
     * @param {string} selector
     * @param {string} text
     * @param {object} [opts]
     * @param {number}  [opts.timeout=10000]
     * @param {boolean} [opts.clearFirst=true]
     */
    async safeType(selector, text, opts = {}) {
        const { timeout = 10000, clearFirst = true } = opts;
        await this.page.waitForSelector(selector, { visible: true, timeout });
        await this.humanDelay(100, 400);

        if (clearFirst) {
            await this.page.click(selector, { clickCount: 3 });
            await this.humanDelay(80, 200);
        }

        // Randomise per-keystroke delay: 60–140ms
        await this.page.type(selector, text, {
            delay: Math.floor(Math.random() * 80) + 60,
        });
        await this.humanDelay(200, 600);
    }

    /**
     * Wait for a selector to appear (defaults to 15 s portal timeout).
     * @param {string} selector
     * @param {number} [timeout=15000]
     */
    async waitForResults(selector, timeout = 15000) {
        await this.page.waitForSelector(selector, { visible: true, timeout });
    }

    /**
     * Move the mouse to a random position on the page before interacting.
     * Helps avoid bot-detection heuristics that watch for direct element clicks.
     */
    async randomMouseMove() {
        const x = Math.floor(Math.random() * 800) + 100;
        const y = Math.floor(Math.random() * 400) + 100;
        await this.page.mouse.move(x, y, { steps: 10 });
        await this.humanDelay(100, 300);
    }

    /**
     * Safely navigate to a URL, waiting for network idle.
     * @param {string} url
     * @param {number} [timeout=15000]
     */
    async goto(url, timeout = 15000) {
        await this.page.goto(url, { waitUntil: 'networkidle2', timeout });
    }

    /**
     * Recover the page after a crash or unexpected state by creating a fresh tab.
     * The adapter's `this.page` is replaced so subsequent calls use the new tab.
     */
    async resetPage() {
        try {
            const browser = this.page.browser();
            const newPage = await browser.newPage();

            const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
            await newPage.setUserAgent(UA);
            await newPage.setViewport({ width: 1366, height: 768 });
            await newPage.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            await this.page.close().catch(() => {});
            this.page = newPage;
            console.log(`[${this.portalName}] Page reset successfully.`);
        } catch (err) {
            console.error(`[${this.portalName}] Failed to reset page:`, err.message);
        }
    }

    // ─── Date / value formatting helpers ────────────────────────────────────────

    /**
     * Format a YYYY-MM-DD date string into various portal-friendly formats.
     * @param {string|Date} dateInput
     * @param {'DD/MM/YYYY'|'MM/DD/YYYY'|'YYYY-MM-DD'|'DD-Mon-YYYY'|'D MMM YYYY'} format
     * @returns {string}
     */
    formatDate(dateInput, format = 'DD/MM/YYYY') {
        const d = new Date(dateInput);
        const day   = String(d.getUTCDate()).padStart(2, '0');
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const year  = d.getUTCFullYear();
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const mon   = MONTHS[d.getUTCMonth()];

        switch (format) {
            case 'DD/MM/YYYY':   return `${day}/${month}/${year}`;
            case 'MM/DD/YYYY':   return `${month}/${day}/${year}`;
            case 'YYYY-MM-DD':   return `${year}-${month}-${day}`;
            case 'DD-Mon-YYYY':  return `${day}-${mon}-${year}`;
            case 'D MMM YYYY':   return `${parseInt(day)} ${mon} ${year}`;
            default:             return `${day}/${month}/${year}`;
        }
    }

    /**
     * Map 'economy'|'business'|'first' to a portal-specific class label.
     * Override in each adapter if the portal uses different terminology.
     * @param {string} classType
     * @returns {string}
     */
    mapClass(classType) {
        const map = { economy: 'Economy', business: 'Business', first: 'First' };
        return map[classType] || 'Economy';
    }

    /**
     * Map IATA code to a city name, for portals that use full city names in dropdowns.
     * @param {string} iata
     * @returns {string}
     */
    iataToCity(iata) {
        const cities = {
            LOS: 'Lagos', ABV: 'Abuja', PHC: 'Port Harcourt', KAN: 'Kano',
            ENU: 'Enugu', CBQ: 'Calabar', QOW: 'Owerri', BNI: 'Benin',
            QRW: 'Warri', QUO: 'Uyo', ABB: 'Asaba', KAD: 'Kaduna',
        };
        return cities[iata] || iata;
    }

    /**
     * Build a standardized flight result object.
     * Adapters should call this to ensure consistent output shape.
     * @param {object} raw
     * @returns {StandardizedFlight}
     */
    buildResult(raw) {
        return {
            airline:         raw.airline         || null,
            airline_code:    raw.airline_code     || null,
            flight_number:   raw.flight_number    || 'TBC',
            departure_time:  raw.departure_time   || null,  // ISO 8601 string
            arrival_time:    raw.arrival_time     || null,  // ISO 8601 string
            price:           Number(raw.price)    || 0,
            currency:        raw.currency         || 'NGN',
            class:           raw.class            || 'economy',
            stops:           raw.stops            ?? 0,
            seats_available: raw.seats_available  ?? null,
            baggage:         raw.baggage          || null,
            booking_code:    raw.booking_code     || null,
            portal_name:     this.portalName,
        };
    }
}

/**
 * @typedef {object} StandardizedFlight
 * @property {string}      airline
 * @property {string}      airline_code
 * @property {string}      flight_number
 * @property {string}      departure_time   - ISO 8601
 * @property {string}      arrival_time     - ISO 8601
 * @property {number}      price            - In NGN
 * @property {string}      currency
 * @property {string}      class
 * @property {number}      stops
 * @property {number|null} seats_available
 * @property {string|null} baggage
 * @property {string|null} booking_code
 * @property {string}      portal_name
 */

module.exports = { BasePortalAdapter };
