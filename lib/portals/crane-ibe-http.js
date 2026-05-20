'use strict';

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Browserless HTTP client for the Crane IBE booking engine.
 *
 * All three portals (Air Peace, Arik Air, Ibom Air) run the same Java EE IBE
 * at different subdomains. The search flow is:
 *   1. GET /ibe/search          → establishes a Java session + extracts tokens
 *   2. GET /ibe/availability/create;jsessionid=... → submits search, parses results
 *
 * No login is required to search. Sessions are cheap to re-create.
 */
class CraneIbeHttpClient {
    /**
     * @param {string} portalName  - 'airpeace' | 'arik' | 'ibom'
     * @param {string} baseUrl     - e.g. 'https://book-airpeace.crane.aero'
     * @param {string} airline     - Display name, e.g. 'Air Peace'
     * @param {string} airlineCode - IATA code, e.g. 'P4'
     */
    constructor(portalName, baseUrl, airline, airlineCode) {
        this.portalName  = portalName;
        this.baseUrl     = baseUrl;
        this.airline     = airline;
        this.airlineCode = airlineCode;

        this._cookies = {};   // name → value
        this._session = null; // { jsessionid, sid, cid, dateFieldName }
        this._ready   = false;
    }

    // ─── Public API ─────────────────────────────────────────────────────────

    get isReady() { return this._ready; }

    /**
     * Load the search page and extract session tokens. Cheap to call — it's
     * just one GET request. Must succeed before search() can run.
     * @returns {Promise<boolean>}
     */
    async initSession() {
        try {
            console.log(`[${this.portalName}] Initialising HTTP session...`);
            const html = await this._get('/ibe/search');
            this._session = this._extractTokens(html);

            if (!this._session) {
                if (this._isCloudflareChallenge(html)) {
                    console.warn(`[${this.portalName}] Cloudflare challenge — cannot init session via HTTP.`);
                } else {
                    console.warn(`[${this.portalName}] Session tokens not found in page HTML.`);
                }
                this._ready = false;
                return false;
            }

            this._ready = true;
            console.log(`[${this.portalName}] Session ready (jsid=${this._session.jsessionid.slice(0, 8)}...)`);
            return true;
        } catch (err) {
            console.error(`[${this.portalName}] Session init error: ${err.message}`);
            this._ready = false;
            return false;
        }
    }

    /**
     * Search for available flights.
     *
     * @param {object} params
     * @param {string} params.origin      - IATA code, e.g. 'LOS'
     * @param {string} params.destination - IATA code, e.g. 'ABV'
     * @param {string} params.date        - YYYY-MM-DD
     * @param {number} [params.passengers=1]
     * @returns {Promise<Array>} StandardizedFlight objects
     */
    async search({ origin, destination, date, passengers = 1 }) {
        if (!this._ready) {
            const ok = await this.initSession();
            if (!ok) return [];
        }

        const path   = `/ibe/availability/create;jsessionid=${this._session.jsessionid}`;
        const params = this._buildParams({ origin, destination, date, passengers });

        let html;
        try {
            html = await this._get(path, params);
        } catch (err) {
            // Session likely expired — reset and retry once
            console.warn(`[${this.portalName}] Search request failed (${err.message}), retrying after re-init...`);
            this._ready   = false;
            this._session = null;
            const ok = await this.initSession();
            if (!ok) return [];
            html = await this._get(
                `/ibe/availability/create;jsessionid=${this._session.jsessionid}`,
                this._buildParams({ origin, destination, date, passengers })
            );
        }

        return this._parseResults(html, date);
    }

    // ─── Private: HTTP ───────────────────────────────────────────────────────

    async _get(path, params = {}) {
        const url = `${this.baseUrl}${path}`;
        const response = await axios.get(url, {
            params,
            headers: {
                'User-Agent':      UA,
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection':      'keep-alive',
                'Referer':         `${this.baseUrl}/ibe/search`,
                'Cookie':          this._cookieStr(),
            },
            maxRedirects:   10,
            timeout:        20000,
            validateStatus: s => s < 500,
        });

        this._saveCookies(response.headers['set-cookie']);
        return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    }

    _cookieStr() {
        return Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    _saveCookies(header) {
        if (!header) return;
        const list = Array.isArray(header) ? header : [header];
        for (const h of list) {
            const [nameVal] = h.split(';');
            const eq = nameVal.indexOf('=');
            if (eq === -1) continue;
            const name = nameVal.slice(0, eq).trim();
            const val  = nameVal.slice(eq + 1).trim();
            if (name) this._cookies[name] = val;
        }
    }

    // ─── Private: Session token extraction ──────────────────────────────────

    _extractTokens(html) {
        // jsessionid is embedded in the form action URL
        const jsMatch   = html.match(/action="\/ibe\/availability\/create;jsessionid=([A-F0-9]+)"/i);
        const sidMatch  = html.match(/name="_sid"\s+value="([^"]+)"/);
        const cidMatch  = html.match(/name="_cid"\s+value="([^"]+)"/);
        // Date field name has a random anti-CSRF suffix: flightRequestList[0].date_rand98
        const dateMatch = html.match(/name="(flightRequestList\[0\]\.date_[a-zA-Z0-9]+)"/);

        if (!jsMatch || !sidMatch || !cidMatch || !dateMatch) return null;

        return {
            jsessionid:    jsMatch[1],
            sid:           sidMatch[1],
            cid:           cidMatch[1],
            dateFieldName: dateMatch[1],
        };
    }

    _isCloudflareChallenge(html) {
        return html.includes('cf-browser-verification')
            || html.includes('Just a moment')
            || html.includes('cf-challenge')
            || html.includes('Checking your browser');
    }

    // ─── Private: Search params ──────────────────────────────────────────────

    _buildParams({ origin, destination, date, passengers }) {
        const s = this._session;
        return {
            '_sid':  s.sid,
            '_cid':  s.cid,
            'flightRequestList[0].depPort':                origin,
            'flightRequestList[0].arrPort':                destination,
            [s.dateFieldName]:                             this._fmtDate(date),
            'tripType':                                    'ONE_WAY',
            'passengerQuantities[0].passengerType':        'ADLT',
            'passengerQuantities[0].quantity':             String(passengers),
            'passengerQuantities[1].passengerType':        'CHLD',
            'passengerQuantities[1].quantity':             '0',
            'passengerQuantities[2].passengerType':        'INFT',
            'passengerQuantities[2].quantity':             '0',
            'redirectHome':                                'true',
        };
    }

    _fmtDate(dateStr) {
        // 'YYYY-MM-DD' → 'DD MMM YYYY' (e.g. '20 May 2026')
        const d   = new Date(dateStr + 'T12:00:00Z');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }

    // ─── Private: Results parsing ────────────────────────────────────────────

    _parseResults(html, searchDate) {
        // Guard: Cloudflare challenge or error page
        if (this._isCloudflareChallenge(html) || html.includes('cf-error-details')) {
            console.warn(`[${this.portalName}] Cloudflare page returned — marking session invalid.`);
            this._ready = false;
            return [];
        }

        // 1. Try JSON API response first (Crane IBE may return application/json)
        if (html.startsWith('{') || html.startsWith('[')) {
            try {
                const data = JSON.parse(html);
                const flights = data.flights || data.journeys || data.results
                    || data.availabilities || data.data?.flights || (Array.isArray(data) ? data : null);
                if (Array.isArray(flights) && flights.length > 0) {
                    console.log(`[${this.portalName}] Parsed ${flights.length} flight(s) from JSON response.`);
                    return flights.map(f => this._normalizeJson(f)).filter(r => r.price > 0);
                }
            } catch {
                // Not JSON — fall through
            }
        }

        // 2. Extract JSON embedded in <script> tags
        const embedded = this._extractEmbeddedJson(html);
        if (embedded.length > 0) {
            console.log(`[${this.portalName}] Parsed ${embedded.length} flight(s) from embedded JSON.`);
            return embedded;
        }

        // 3. No flights available
        const lower = html.toLowerCase();
        const noFlight = ['no flights available', 'no results found', 'no availability', 'no fare available', 'no flight available'];
        if (noFlight.some(t => lower.includes(t))) {
            console.log(`[${this.portalName}] No flights available for this search.`);
            return [];
        }

        // 4. HTML card extraction
        const htmlResults = this._extractFromHtml(html, searchDate);
        if (htmlResults.length > 0) {
            console.log(`[${this.portalName}] Parsed ${htmlResults.length} flight(s) from HTML.`);
            return htmlResults;
        }

        // 5. Nothing found — log a snippet for debugging
        console.warn(`[${this.portalName}] Could not extract results (${html.length} bytes). First 300 chars: ${html.slice(0, 300)}`);
        return [];
    }

    _extractEmbeddedJson(html) {
        const patterns = [
            // Common patterns for Crane IBE and generic IBE systems
            /var\s+availabilityData\s*=\s*(\{[\s\S]*?\})\s*;/,
            /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/,
            /var\s+flightData\s*=\s*(\[[\s\S]*?\])\s*;/,
            /"flights"\s*:\s*(\[[\s\S]*?\])/,
            /"journeys"\s*:\s*(\[[\s\S]*?\])/,
            /"availabilities"\s*:\s*(\[[\s\S]*?\])/,
        ];

        for (const pat of patterns) {
            const m = html.match(pat);
            if (!m) continue;
            try {
                const parsed = JSON.parse(m[1]);
                const flights = Array.isArray(parsed) ? parsed
                    : (parsed.flights || parsed.journeys || parsed.results || parsed.availabilities);
                if (Array.isArray(flights) && flights.length > 0) {
                    return flights.map(f => this._normalizeJson(f)).filter(r => r.price > 0);
                }
            } catch {
                continue;
            }
        }
        return [];
    }

    _normalizeJson(f) {
        const price = f.totalFare || f.totalPrice || f.price
            || f.fare?.totalAmount || f.fare?.total || f.lowestFare || 0;

        const flightNum = f.flightNumber || f.flight_number || f.flightNo
            || f.segments?.[0]?.flightNumber || `${this.airlineCode}-TBC`;

        const depTime = f.departureDateTime || f.departureTime || f.departure?.dateTime
            || f.segments?.[0]?.departureDateTime;
        const arrTime = f.arrivalDateTime || f.arrivalTime || f.arrival?.dateTime
            || f.segments?.[0]?.arrivalDateTime;

        return {
            portal_name:     this.portalName,
            airline:         this.airline,
            airline_code:    this.airlineCode,
            flight_number:   flightNum,
            departure_time:  depTime || null,
            arrival_time:    arrTime || null,
            price:           typeof price === 'object' ? (price.amount || 0) : Number(price),
            currency:        f.currency || f.currencyCode || 'NGN',
            class:           f.cabinClass || f.cabin || 'economy',
            stops:           f.stops ?? f.numberOfStops ?? (f.segments?.length > 1 ? f.segments.length - 1 : 0),
            seats_available: f.seatsAvailable || f.availableSeats || null,
            baggage:         f.baggageAllowance || f.baggage || null,
            booking_code:    f.bookingClass || f.fareCode || null,
        };
    }

    _extractFromHtml(html, searchDate) {
        const results = [];

        // Crane IBE result cards use class names containing these keywords
        const cardRe = /<[^>]+class="[^"]*(?:journey-card|flight-card|flight-item|availability-flight|result-item)[^"]*"[^>]*>([\s\S]*?)(?=<[^>]+class="[^"]*(?:journey-card|flight-card|flight-item|availability-flight|result-item)[^"]*"|$)/gi;

        let m;
        while ((m = cardRe.exec(html)) !== null && results.length < 20) {
            const card = m[0];

            const price     = this._parsePrice(this._extractByClass(card, 'total-fare|price-amount|fare-amount|total-price'));
            if (price <= 0) continue;

            const flightNo  = this._extractByClass(card, 'flight-no|flight-number|flt-num');
            const depText   = this._extractByClass(card, 'dep-time|departure-time|depart-time');
            const arrText   = this._extractByClass(card, 'arr-time|arrival-time|arrive-time');

            results.push({
                portal_name:    this.portalName,
                airline:        this.airline,
                airline_code:   this.airlineCode,
                flight_number:  flightNo ? this._stripTags(flightNo).trim() : `${this.airlineCode}-TBC`,
                departure_time: depText  ? this._parseTime(this._stripTags(depText).trim(), searchDate) : null,
                arrival_time:   arrText  ? this._parseTime(this._stripTags(arrText).trim(), searchDate) : null,
                price,
                currency:       'NGN',
                class:          'economy',
                stops:          0,
                seats_available: null,
                baggage:        null,
                booking_code:   null,
            });
        }

        return results;
    }

    _extractByClass(html, classKeywords) {
        const re = new RegExp(`class="[^"]*(?:${classKeywords})[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
        const m  = html.match(re);
        return m ? m[1] : null;
    }

    _stripTags(str) {
        return str.replace(/<[^>]+>/g, '').trim();
    }

    _parsePrice(str) {
        if (!str) return 0;
        const s = this._stripTags(str).replace(/[₦NGN,\s]/gi, '');
        if (/k$/i.test(s))  return parseFloat(s) * 1_000;
        if (/m$/i.test(s))  return parseFloat(s) * 1_000_000;
        return parseFloat(s) || 0;
    }

    _parseTime(timeStr, baseDate) {
        if (!timeStr || !baseDate) return null;
        if (timeStr.includes('T') || timeStr.includes('Z')) return timeStr;
        // Handle "07:30" or "7:30 AM" formats
        const clean = timeStr.replace(/\s?(AM|PM)/i, '').trim();
        const isPM  = /PM/i.test(timeStr);
        const parts = clean.split(':').map(Number);
        let [hh, mm] = parts;
        if (isPM && hh !== 12) hh += 12;
        if (!isPM && hh === 12) hh = 0;
        return `${baseDate}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00+01:00`;
    }
}

module.exports = { CraneIbeHttpClient };
