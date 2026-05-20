'use strict';

const { BasePortalAdapter } = require('../base-adapter');

// ─── Confirmed selectors (verified via npm run discover on 2026-05-19) ─────────
//
// All three portals use the Crane IBE engine at different subdomains.
// Origin/destination are standard <select> elements with IATA code values.
// Date picker is calendar-only (data-allowed-manual="false").
// No cabin class selector — these carriers only offer Economy.
// Login is NOT required to search — the form loads unauthenticated.
// ──────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
    // Search form
    tripTypeOneWay:    '#one-way',
    originSelect:      '#firstDepPort',
    destSelect:        '#firstArrPort',
    originDropdownBtn: 'button[data-id="firstDepPort"]',
    destDropdownBtn:   'button[data-id="firstArrPort"]',
    dateInput:         'input.js-overlay-datepicker',
    passengersToggle:  '#textPersonCount',
    adultIncrement:    'span.counter__plus.adultCount',
    searchButton:      'button[type="submit"]',

    // Results — confirmed selectors from live page inspection 2026-05-20
    resultCard:    '.selection-item',          // one per flight
    depTime:       '.left-info-block .time',
    depPort:       '.left-info-block .port',
    depDate:       '.left-info-block .date',
    arrTime:       '.right-info-block .time',
    arrPort:       '.right-info-block .port',
    flightNo:      '.mobile-route-block .middle-block .flight-no',
    duration:      '.mobile-route-block .middle-block .flight-duration',
    stops:         '.mobile-route-block .middle-block .total-stop',
};

// ─── Crane IBE API interception ────────────────────────────────────────────────
// Intercept the JSON availability response — faster and more reliable than DOM parsing.
// Update URL patterns after inspecting a live search's network tab.
const API_PATTERNS = [
    '/availability', '/avail', '/api/v', '/ibe/api/',
    '/flights/search', '/search/availability', '/getFlights',
];

// ─── CraneIbeAdapter ──────────────────────────────────────────────────────────

class CraneIbeAdapter extends BasePortalAdapter {
    /**
     * @param {import('puppeteer').Page} page
     * @param {string} portalName  - 'airpeace' | 'arik' | 'ibom'
     * @param {string} portalUrl   - Base URL, e.g. 'https://book-airpeace.crane.aero'
     * @param {string} airline     - Display name, e.g. 'Air Peace'
     * @param {string} airlineCode - IATA code, e.g. 'P4'
     */
    constructor(page, portalName, portalUrl, airline, airlineCode) {
        super(page, portalName);
        this.portalUrl   = portalUrl;
        this.airline     = airline;
        this.airlineCode = airlineCode;
        this.baseDate    = null;

        this._apiResults          = [];
        this._interceptionEnabled = false;
    }

    // ─── Session check ────────────────────────────────────────────────────────
    // These portals don't require login to search. We just verify the form loads.

    async isLoggedIn(timeout = 90000) {
        try {
            await this.page.goto(`${this.portalUrl}/ibe/search`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000,
            }).catch(() => {}); // ignore navigation errors — Cloudflare may redirect
            // Wait up to 90s for Cloudflare to auto-solve and the form to appear
            await this._waitForSearchForm(timeout);
            const el = await this.page.$(SELECTORS.originSelect);
            return el !== null;
        } catch {
            return false;
        }
    }

    // ─── Navigation ───────────────────────────────────────────────────────────

    async navigateToSearchPage() {
        await this._enableApiInterception();
        await this.goto(`${this.portalUrl}/ibe/search`, 20000);
        await this._waitForSearchForm(30000);
    }

    // ─── Form filling ─────────────────────────────────────────────────────────

    async fillSearchForm({ origin, destination, date, passengers }) {
        this.baseDate = date;
        this._apiResults.splice(0);

        // 1. One-way — use page.mouse.click() with real coordinates so jQuery handlers fire.
        //    Also update #tripType hidden field via JS (server-side trip type value).
        const oneWayClicked = await this._clickOneWayWithRealMouse();
        if (!oneWayClicked) {
            // Fallback: direct JS manipulation
            await this.page.evaluate(() => {
                const radio = document.querySelector('#one-way');
                if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
                const hidden = document.querySelector('#tripType');
                if (hidden) { hidden.value = 'ONE_WAY'; hidden.dispatchEvent(new Event('change', { bubbles: true })); }
            });
        }
        await this.humanDelay(600, 900); // wait for IBE to hide round-trip section

        const tripState = await this.page.evaluate(() => ({
            oneWayChecked:          document.querySelector('#one-way')?.checked,
            tripTypeHidden:         document.querySelector('#tripType')?.value,
            roundTripSectionHidden: !document.querySelector('#roundTripDepartureDate, [name*="roundTrip"]')
                                    ?.offsetParent,
        }));
        console.log(`[${this.portalName}] Trip type:`, JSON.stringify(tripState));

        // 2. Origin airport
        await this._selectAirport(SELECTORS.originSelect, SELECTORS.originDropdownBtn, origin);

        // Wait for the portGroupsByCountry AJAX triggered by origin change to finish
        // before setting destination (otherwise the AJAX response resets the dest value).
        await this.humanDelay(2000, 2500);

        // 3. Destination airport
        await this._selectAirport(SELECTORS.destSelect, SELECTORS.destDropdownBtn, destination);

        // Brief pause then verify destination held
        await this.humanDelay(600, 900);
        const formCheck = await this.page.evaluate((depSel, arrSel) => ({
            dep: document.querySelector(depSel)?.value,
            arr: document.querySelector(arrSel)?.value,
        }), SELECTORS.originSelect, SELECTORS.destSelect);
        console.log(`[${this.portalName}] Airports after selection: dep=${formCheck.dep} arr=${formCheck.arr}`);

        // 4. Date — calendar-only (portal disables manual typing)
        await this._openAndPickDate(date);

        // 5. Passengers (default is 1 adult; only increment if more needed)
        if (passengers > 1) {
            await this.safeClick(SELECTORS.passengersToggle);
            await this.humanDelay(400, 800);
            for (let i = 1; i < passengers; i++) {
                await this.safeClick(SELECTORS.adultIncrement);
                await this.humanDelay(250, 500);
            }
            // Close popup by pressing Escape or clicking outside
            await this.page.keyboard.press('Escape');
            await this.humanDelay(300, 600);
        }

        // 6. Submit — the Crane IBE does a full page POST to /ibe/availability/create

        // Close the datepicker if still open — it can overlay the submit button
        await this._closeCalendarIfOpen();

        // Get the submit button's real screen coordinates and click with page.mouse
        await this._clickSubmitButton();
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40000 })
            .catch(() => {});
    }

    // ─── Result extraction ────────────────────────────────────────────────────

    async extractResults() {
        try {
            const currentUrl = this.page.url();
            console.log(`[${this.portalName}] Results page: ${currentUrl}`);

            if (currentUrl.includes('/ibe/search')) {
                console.log(`[${this.portalName}] Still on search page — form validation failed.`);
                return [];
            }
            if (!currentUrl.includes('/ibe/')) {
                console.log(`[${this.portalName}] Unexpected URL — no results.`);
                return [];
            }

            // Check for intercepted API responses (some IBE versions also use XHR)
            if (this._apiResults.length > 0) {
                console.log(`[${this.portalName}] Intercepted ${this._apiResults.length} API result(s).`);
                return this._normalizeApiResults(this._apiResults);
            }

            // Wait for flight cards — confirmed selector: .selection-item
            await this.page.waitForSelector(SELECTORS.resultCard, { timeout: 15000 }).catch(() => {});
            await this.humanDelay(500, 800);

            const raw = await this.page.evaluate((S) => {
                return Array.from(document.querySelectorAll(S.resultCard)).map(card => {
                    const q = (sel) => card.querySelector(sel)?.textContent.trim() || null;

                    // Find lowest price in the card (first currency amount found)
                    let priceText = null;
                    card.querySelectorAll('*').forEach(el => {
                        if (el.childElementCount > 0 || priceText) return;
                        const t = el.textContent.trim();
                        if (/[₦$€£][\s\d,]+/.test(t) || /[\d,]{3,}\.\d{2}/.test(t)) {
                            priceText = t;
                        }
                    });

                    return {
                        flightNo:  q(S.flightNo),
                        depTime:   q(S.depTime),
                        depPort:   q(S.depPort),
                        depDate:   q(S.depDate),
                        arrTime:   q(S.arrTime),
                        arrPort:   q(S.arrPort),
                        stops:     q(S.stops),
                        duration:  q(S.duration),
                        priceText,
                    };
                }).filter(r => r.depTime && r.arrTime);
            }, SELECTORS);

            console.log(`[${this.portalName}] Parsed ${raw.length} flight(s):`,
                raw.map(r => `${r.flightNo} ${r.depTime}→${r.arrTime} ${r.priceText}`).join(' | '));

            return raw.map(r => this.buildResult({
                airline:        this.airline,
                airline_code:   this.airlineCode,
                flight_number:  r.flightNo || `${this.airlineCode}-TBC`,
                departure_time: this._parseTime(r.depTime, this.baseDate),
                arrival_time:   this._parseTime(r.arrTime, this.baseDate),
                price:          this._parsePrice(r.priceText),
                currency:       r.priceText?.includes('$') ? 'USD' : 'NGN',
                class:          'economy',
                stops:          this._parseStops(r.stops),
                seats_available: null,
                baggage:        null,
            })).filter(r => r.price > 0);

        } catch (err) {
            if (err.message.includes('timeout') || err.message.includes('waiting')) {
                console.log(`[${this.portalName}] No results (timeout).`);
                return [];
            }
            throw err;
        }
    }

    // ─── Private: airport selection ───────────────────────────────────────────

    async _selectAirport(selectSel, btnSel, iataCode) {
        // Primary: drive the underlying <select> directly with the IATA code value
        const selected = await this.page.evaluate((sel, code) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const opt = Array.from(el.options).find(o => o.value === code);
            if (!opt) return false;
            el.value = code;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, selectSel, iataCode);

        if (selected) {
            await this.humanDelay(400, 800);
            return;
        }

        // Fallback: open the bootstrap-select dropdown and click the matching option
        console.warn(`[${this.portalName}] Direct select failed for ${iataCode} — trying bootstrap-select click.`);
        await this.safeClick(btnSel).catch(() => {});
        await this.humanDelay(400, 700);

        const clicked = await this.page.evaluate((code) => {
            const options = Array.from(document.querySelectorAll('.dropdown-menu.open a[role="option"], .bs-actionsbox ~ ul a'));
            for (const opt of options) {
                if (opt.textContent.includes(code)) {
                    opt.click();
                    return true;
                }
            }
            return false;
        }, iataCode);

        if (!clicked) {
            console.warn(`[${this.portalName}] Could not select airport ${iataCode}.`);
        }
        await this.humanDelay(300, 600);
    }

    // ─── Private: date picker ─────────────────────────────────────────────────
    // Portal has data-allowed-manual="false" — must always use the calendar.

    async _openAndPickDate(dateStr) {
        const d = new Date(dateStr + 'T12:00:00Z');
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const formatted = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

        // Open the calendar by clicking whichever date trigger is present.
        // Try the visible overlay input first, fall back to the hidden input.
        const opened = await this._openCalendar();
        if (!opened) {
            console.warn(`[${this.portalName}] Could not open date calendar — trying native setter.`);
            await this._forceSetDateInputs(formatted);
            return;
        }
        await this.humanDelay(400, 600);

        // With the calendar visibly open, click the correct date cell.
        // This is the same action a real user takes and will update BOTH the
        // hidden input and the visible overlay input via the IBE's own handlers.
        const picked = await this._pickCalendarDate(dateStr);
        if (picked) {
            console.log(`[${this.portalName}] Date picked via calendar click: ${formatted}`);
            await this.humanDelay(300, 500);
            return;
        }

        // Calendar opened but we couldn't click the cell (wrong month showing?) —
        // try the jQuery API as a fallback, then force-set both inputs.
        console.warn(`[${this.portalName}] Calendar click missed — trying API + native setter.`);
        await this.page.evaluate((fmt) => {
            const input = document.querySelector('#oneWayDepartureDate');
            if (input && window.$ && $.fn.daterangepicker) {
                const drp = $(input).data('daterangepicker');
                if (drp) { drp.setStartDate(fmt); drp.setEndDate(fmt); $(input).trigger('apply.daterangepicker', [drp]); }
            }
        }, formatted);
        await this.humanDelay(300, 400);
        await this._forceSetDateInputs(formatted);
        console.warn(`[${this.portalName}] Date forced on both inputs: ${formatted}`);
    }

    async _openCalendar() {
        // Try clicking the visible overlay input first
        for (const sel of [SELECTORS.dateInput, '#oneWayDepartureDate']) {
            try {
                const el = await this.page.$(sel);
                if (!el) continue;
                await el.click();
                // Check if the daterangepicker appeared
                const appeared = await this.page.waitForSelector(
                    '.daterangepicker:not([style*="display: none"]), .daterangepicker-widget',
                    { visible: true, timeout: 4000 }
                ).then(() => true).catch(() => false);
                if (appeared) return true;
            } catch { /* try next */ }
        }
        // Last resort: open via jQuery show()
        return await this.page.evaluate(() => {
            const input = document.querySelector('#oneWayDepartureDate');
            if (input && window.$ && $.fn.daterangepicker) {
                const drp = $(input).data('daterangepicker');
                if (drp) { drp.show(); return true; }
            }
            return false;
        });
    }

    async _forceSetDateInputs(formatted) {
        await this.page.evaluate((fmt) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            for (const sel of ['#oneWayDepartureDate', 'input.js-overlay-datepicker']) {
                const el = document.querySelector(sel);
                if (el) {
                    setter.call(el, fmt);
                    el.dispatchEvent(new Event('input',  { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, formatted);
    }

    async _pickCalendarDate(dateStr) {
        const d = new Date(dateStr + 'T12:00:00Z');
        const targetDay   = d.getUTCDate();
        const targetMonth = d.getUTCMonth();
        const targetYear  = d.getUTCFullYear();

        for (let attempt = 0; attempt < 3; attempt++) {
            // Get the center coordinates of the matching cell so we can use
            // page.mouse.click() — this fires authentic mouse events that jQuery
            // event delegation responds to (unlike el.click() inside evaluate).
            const coords = await this.page.evaluate((day, month, year) => {
                const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

                const picker = Array.from(document.querySelectorAll('.daterangepicker')).find(el =>
                    el.offsetWidth > 0 && el.offsetHeight > 0
                );
                if (!picker) return null;

                const cells = Array.from(picker.querySelectorAll(
                    'td.available, td.day:not(.disabled):not(.off), td[data-date]'
                ));

                const getRect = (el) => {
                    const r = el.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2, html: el.outerHTML.substring(0, 80) };
                };

                for (const el of cells) {
                    if (el.classList.contains('disabled') || el.classList.contains('off')) continue;
                    if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;

                    const ts = parseInt(el.getAttribute('data-date'));
                    if (!isNaN(ts) && ts > 0) {
                        const cd = new Date(ts);
                        if (cd.getUTCFullYear() === year && cd.getUTCMonth() === month && cd.getUTCDate() === day) {
                            return getRect(el);
                        }
                    }

                    const label = el.getAttribute('aria-label') || '';
                    if (label) {
                        const parsed = new Date(label);
                        if (!isNaN(parsed) &&
                            parsed.getUTCFullYear() === year &&
                            parsed.getUTCMonth()    === month &&
                            parsed.getUTCDate()     === day) {
                            return getRect(el);
                        }
                    }

                    if (el.textContent.trim() === String(day)) {
                        const container = el.closest('.calendar-table') || el.closest('table') || picker;
                        const header = container?.querySelector('.month, th.month, .datepicker-switch');
                        if (header) {
                            const hText = header.textContent;
                            if (hText.includes(String(year)) && hText.includes(MONTHS[month])) {
                                return getRect(el);
                            }
                        }
                    }
                }
                return null;
            }, targetDay, targetMonth, targetYear);

            if (coords) {
                console.log(`[${this.portalName}] Clicking cell at (${Math.round(coords.x)},${Math.round(coords.y)})`);
                await this.page.mouse.click(coords.x, coords.y);
                await this.humanDelay(400, 600);

                // Handle autoApply: false — an Apply button may appear after cell click
                const applied = await this._clickApplyIfPresent();
                if (applied) await this.humanDelay(200, 400);

                return true;
            }

            // Cell not found — maybe the calendar is on a different month; navigate forward
            const nextBtn = await this.page.$('.daterangepicker:not([style*="display: none"]) .next, .daterangepicker:not([style*="display: none"]) th.next');
            if (nextBtn) { await nextBtn.click(); await this.humanDelay(400, 600); } else break;
        }
        return false;
    }

    async _clickApplyIfPresent() {
        return await this.page.evaluate(() => {
            const picker = Array.from(document.querySelectorAll('.daterangepicker')).find(el =>
                el.offsetWidth > 0 && el.offsetHeight > 0
            );
            if (!picker) return false;
            const btn = picker.querySelector('.applyBtn, .drp-buttons .applyBtn, button[data-action="accept"]');
            if (btn && btn.offsetWidth > 0) { btn.click(); return true; }
            return false;
        });
    }

    async _clickOneWayWithRealMouse() {
        // Prefer clicking the <label for="one-way"> since the IBE's jQuery handler
        // is typically bound to label click / radio change via delegation.
        // Fallback to the radio element itself.
        const coords = await this.page.evaluate(() => {
            const target = document.querySelector('label[for="one-way"]')
                        || document.querySelector('#one-way');
            if (!target) return null;
            const r = target.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (!coords) return false;
        await this.page.mouse.click(coords.x, coords.y);
        // Also update the hidden tripType field (server-side trip type value)
        await this.page.evaluate(() => {
            const hidden = document.querySelector('#tripType');
            if (hidden) { hidden.value = 'ONE_WAY'; hidden.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        return true;
    }

    async _closeCalendarIfOpen() {
        const isOpen = await this.page.evaluate(() =>
            !!Array.from(document.querySelectorAll('.daterangepicker')).find(e => e.offsetWidth > 0)
        );
        if (!isOpen) return;
        // Press Escape — daterangepicker closes on keydown Escape
        await this.page.keyboard.press('Escape');
        await this.humanDelay(300, 500);
        // If still open, click somewhere neutral (top-left corner of the page body)
        const stillOpen = await this.page.evaluate(() =>
            !!Array.from(document.querySelectorAll('.daterangepicker')).find(e => e.offsetWidth > 0)
        );
        if (stillOpen) {
            await this.page.mouse.click(100, 100);
            await this.humanDelay(300, 400);
        }
    }

    async _clickSubmitButton() {
        const coords = await this.page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, SELECTORS.searchButton);

        if (!coords) return false;
        await this.page.mouse.click(coords.x, coords.y);
        return true;
    }

    // ─── Private: wait for search form ───────────────────────────────────────

    async _waitForSearchForm(timeout = 30000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const el = await this.page.$(SELECTORS.originSelect).catch(() => null);
            if (el) return;
            await this.humanDelay(1000, 1500);
        }
        console.warn(`[${this.portalName}] Search form did not appear within ${timeout}ms.`);
    }

    // ─── Private: API interception ────────────────────────────────────────────

    async _enableApiInterception() {
        if (this._interceptionEnabled) return;

        this.page.on('response', async (response) => {
            try {
                const url = response.url();
                const isApi = API_PATTERNS.some(p => url.toLowerCase().includes(p));
                if (!isApi) return;

                const ct = response.headers()['content-type'] || '';
                if (!ct.includes('application/json')) return;

                const json = await response.json().catch(() => null);
                if (!json) return;

                const flights = json.flights || json.journeys || json.results
                    || json.availabilities || json.data?.flights || json.data?.journeys
                    || (Array.isArray(json) ? json : null);

                if (Array.isArray(flights) && flights.length > 0) {
                    this._apiResults.push(...flights);
                    console.log(`[${this.portalName}] Intercepted ${flights.length} flight(s) from ${url.split('?')[0]}`);
                }
            } catch {
                // Ignore parse errors silently
            }
        });

        this._interceptionEnabled = true;
    }

    // ─── Private: normalize API response ─────────────────────────────────────

    _normalizeApiResults(flights) {
        return flights.map(f => {
            const price = f.totalFare || f.totalPrice || f.price
                || f.fare?.totalAmount || f.fare?.total || f.lowestFare || 0;

            const flightNum = f.flightNumber || f.flight_number || f.flightNo
                || f.segments?.[0]?.flightNumber || `${this.airlineCode}-TBC`;

            const depTime = f.departureDateTime || f.departureTime || f.departure?.dateTime
                || f.segments?.[0]?.departureDateTime;
            const arrTime = f.arrivalDateTime || f.arrivalTime || f.arrival?.dateTime
                || f.segments?.[0]?.arrivalDateTime;

            return this.buildResult({
                airline:        this.airline,
                airline_code:   this.airlineCode,
                flight_number:  flightNum,
                departure_time: depTime || null,
                arrival_time:   arrTime || null,
                price:          typeof price === 'object' ? price.amount || 0 : Number(price),
                currency:       f.currency || f.currencyCode || 'NGN',
                class:          f.cabinClass || f.cabin || 'economy',
                stops:          f.stops ?? f.numberOfStops ?? (f.segments?.length > 1 ? f.segments.length - 1 : 0),
                seats_available: f.seatsAvailable || f.availableSeats || null,
                baggage:        f.baggageAllowance || f.baggage || null,
                booking_code:   f.bookingClass || f.fareCode || null,
            });
        }).filter(r => r.price > 0);
    }

    // ─── Private: value parsers ───────────────────────────────────────────────

    _parseTime(timeStr, baseDate) {
        if (!timeStr || !baseDate) return null;
        if (timeStr.includes('T') || timeStr.includes('Z')) return timeStr;
        // Strip AM/PM label if present (mobile block adds it)
        const clean = timeStr.replace(/\s?(AM|PM)/i, '').trim();
        const isPM  = /PM/i.test(timeStr);
        let [hh, mm] = clean.split(':').map(Number);
        if (isNaN(hh) || isNaN(mm)) return null;
        // The times are 24h on the Crane IBE desktop block — only apply AM/PM if explicitly present
        if (/AM|PM/i.test(timeStr)) {
            if (isPM && hh !== 12) hh += 12;
            if (!isPM && hh === 12) hh = 0;
        }
        // baseDate may be "21 May 2026" (from DOM) or "2026-05-21" (ISO from params)
        const isoDate = baseDate.includes('-') ? baseDate
            : (() => { const d = new Date(baseDate + 'T12:00:00Z'); return d.toISOString().slice(0,10); })();
        return `${isoDate}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+01:00`;
    }

    _parsePrice(str) {
        if (!str) return 0;
        const s = str.replace(/[₦$€£NGNUSDFromfrom\s,]/gi, '');
        if (/k$/i.test(s)) return parseFloat(s) * 1000;
        if (/m$/i.test(s)) return parseFloat(s) * 1_000_000;
        const v = parseFloat(s) || 0;
        // If price was in USD (Ibom Air portal), approximate NGN at market rate
        if (str.includes('$') && v > 0 && v < 10000) return Math.round(v * 1600);
        return v;
    }

    _parseStops(str) {
        if (!str) return 0;
        const s = str.toLowerCase();
        if (s.includes('direct') || s.includes('non-stop') || s.includes('nonstop')) return 0;
        const m = s.match(/(\d+)/);
        return m ? parseInt(m[1]) : 0;
    }
}

module.exports = { CraneIbeAdapter, SELECTORS };
