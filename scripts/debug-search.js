'use strict';
/**
 * Debug script — opens Air Peace, fills the form, submits, screenshots results page.
 * Run this to see what the results page HTML looks like so we can write proper selectors.
 */
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
require('dotenv').config();

const ROOT        = path.join(__dirname, '..');
const USER_DIR    = path.join(ROOT, 'browser-sessions', 'airpeace');
const PORTAL_URL  = 'https://book-airpeace.crane.aero';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function run() {
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: USER_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: { width: 1366, height: 768 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Capture ALL network responses
    const responses = [];
    page.on('response', async res => {
        const url = res.url();
        const ct  = res.headers()['content-type'] || '';
        responses.push({ url: url.substring(0, 120), status: res.status(), ct: ct.substring(0, 40) });
    });

    // ── 1. Load search page ────────────────────────────────────────────────────
    console.log('Loading search page...');
    await page.goto(`${PORTAL_URL}/ibe/search`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Wait for form
    console.log('Waiting for #firstDepPort...');
    await page.waitForSelector('#firstDepPort', { visible: true, timeout: 60000 });
    console.log('Form ready.');

    await new Promise(r => setTimeout(r, 1000));

    // ── 2. One-way ─────────────────────────────────────────────────────────────
    await page.$('#one-way').then(el => el?.click()).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // ── 3. Origin = LOS ────────────────────────────────────────────────────────
    const originSet = await page.evaluate(() => {
        const el = document.querySelector('#firstDepPort');
        if (!el) return false;
        const opt = Array.from(el.options).find(o => o.value === 'LOS');
        if (!opt) return false;
        el.value = 'LOS';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    });
    console.log('Origin (LOS) set:', originSet);
    await new Promise(r => setTimeout(r, 600));

    // ── 4. Destination = ABV ───────────────────────────────────────────────────
    const destSet = await page.evaluate(() => {
        const el = document.querySelector('#firstArrPort');
        if (!el) return false;
        const opt = Array.from(el.options).find(o => o.value === 'ABV');
        if (!opt) return false;
        el.value = 'ABV';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    });
    console.log('Destination (ABV) set:', destSet);
    await new Promise(r => setTimeout(r, 600));

    // ── 5. Date ────────────────────────────────────────────────────────────────
    await page.click('#oneWayDepartureDate').catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // Wait for any picker to appear
    const pickerSel = '.daterangepicker, .datepicker, .bootstrap-datetimepicker-widget';
    await page.waitForSelector(pickerSel, { visible: true, timeout: 5000 }).catch(() => {});

    // Take screenshot with picker open
    await page.screenshot({ path: path.join(ROOT, 'debug-datepicker.png'), fullPage: false });
    console.log('Screenshot saved: debug-datepicker.png');

    // Log all picker-related elements visible on page
    const pickerInfo = await page.evaluate(() => {
        const info = {
            daterangepicker: !!document.querySelector('.daterangepicker'),
            daterangepickerVisible: !!document.querySelector('.daterangepicker:not([style*="display: none"])'),
            datepickerDropdown: !!document.querySelector('.datepicker-dropdown'),
            allClasses: [],
        };
        document.querySelectorAll('[class*="picker"], [class*="calendar"], [class*="datepicker"], [class*="daterange"]').forEach(el => {
            const classes = el.className.toString().substring(0, 80);
            const visible  = el.offsetWidth > 0 && el.offsetHeight > 0;
            if (visible) info.allClasses.push(classes);
        });
        return info;
    });
    console.log('\nPicker info:', JSON.stringify(pickerInfo, null, 2));

    // Try clicking a date cell (tomorrow)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDay = tomorrow.getUTCDate();

    const dateClicked = await page.evaluate((day) => {
        const allCells = Array.from(document.querySelectorAll('td'));
        for (const el of allCells) {
            const visible = el.offsetWidth > 0 && el.offsetHeight > 0;
            if (!visible) continue;
            if (el.textContent.trim() === String(day) && !el.classList.contains('off') && !el.classList.contains('disabled')) {
                console.log('Clicking cell:', el.outerHTML.substring(0, 200));
                el.click();
                return { clicked: true, html: el.outerHTML.substring(0, 200), parentClass: el.parentElement?.className };
            }
        }
        return { clicked: false };
    }, targetDay);
    console.log('\nDate click result:', JSON.stringify(dateClicked, null, 2));
    await new Promise(r => setTimeout(r, 800));

    // ── 6. Submit search ───────────────────────────────────────────────────────
    console.log('\nSubmitting search...');
    const [navResult] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => ({ error: e.message })),
        page.click('button[type="submit"]').catch(e => console.log('Submit click error:', e.message)),
    ]);
    console.log('Navigation result:', navResult);

    const resultsUrl = page.url();
    console.log('\nResults page URL:', resultsUrl);

    const title = await page.title().catch(() => '?');
    console.log('Page title:', title);

    await page.screenshot({ path: path.join(ROOT, 'debug-results.png'), fullPage: false });
    console.log('Results screenshot saved: debug-results.png');

    // Log first 2000 chars of page body text
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000));
    console.log('\nPage body text:\n', bodyText);

    // Log all XHR/fetch network responses captured
    console.log('\n=== Network responses captured ===');
    responses.filter(r => !r.url.includes('google') && !r.url.includes('cdn-cgi')).forEach(r => {
        console.log(`  ${r.status} ${r.url} | ${r.ct}`);
    });

    await browser.close();
}

run().catch(err => {
    console.error('Debug failed:', err.message);
    process.exit(1);
});
