'use strict';

/**
 * Portal Selector Discovery Tool
 *
 * Run ONCE after the server has launched the portal browsers and you've
 * logged into each portal manually.
 *
 * What it does:
 *   1. Opens each portal's search page in a new browser window
 *   2. Waits for the page to fully load
 *   3. Dumps every interactive element (id, name, class, placeholder, data-*)
 *   4. Captures network API calls made during the search
 *   5. Takes a full-page screenshot
 *   6. Saves everything to discovery-{portal}.json / .html / .png
 *
 * Usage:
 *   node scripts/discover-selectors.js
 *
 * After running, share the *.json files so the selectors in
 * lib/portals/adapters/crane-ibe-adapter.js can be confirmed and updated.
 */

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
require('dotenv').config();

const ROOT = path.join(__dirname, '..');

const PORTALS = [
    { name: 'airpeace', url: 'https://book-airpeace.crane.aero/ibe/search', airline: 'Air Peace' },
    { name: 'arik',     url: 'https://arikair.crane.aero/ibe/search',        airline: 'Arik Air'  },
    { name: 'ibom',     url: 'https://book-ibomair.crane.aero/ibe/search',   airline: 'Ibom Air'  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function discoverPortal(portal) {
    console.log(`\n[${portal.name}] ── ${portal.airline} ──────────────────────`);

    const userDataDir = path.join(ROOT, 'browser-sessions', portal.name);
    fs.mkdirSync(userDataDir, { recursive: true });

    const browser = await puppeteer.launch({
        headless: false,
        userDataDir,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: { width: 1366, height: 768 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // ── Capture network requests ───────────────────────────────────────────────
    const capturedRequests = [];
    page.on('request', req => {
        const url = req.url();
        if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
            capturedRequests.push({ url, method: req.method(), type: 'request' });
        }
    });

    const capturedResponses = [];
    page.on('response', async res => {
        const url = res.url();
        if (['xhr', 'fetch'].includes(res.request().resourceType())) {
            const ct = res.headers()['content-type'] || '';
            let body = null;
            if (ct.includes('application/json')) {
                body = await res.json().catch(() => null);
            }
            capturedResponses.push({
                url,
                status: res.status(),
                contentType: ct,
                bodyPreview: body ? JSON.stringify(body).substring(0, 500) : null,
            });
        }
    });

    // ── Navigate ───────────────────────────────────────────────────────────────
    console.log(`[${portal.name}] Navigating to ${portal.url} ...`);
    try {
        await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        console.warn(`[${portal.name}] Navigation warning: ${err.message}`);
    }

    // Cloudflare Turnstile blocks fresh sessions — wait for a human to solve it.
    // The script watches for a real form input to appear (up to 90s).
    // If Cloudflare auto-solves, it continues automatically.
    // If not, solve the challenge in the browser window that just opened.
    console.log(`\n[${portal.name}] ⚠️  Waiting for search form to appear (up to 90s).`);
    console.log(`[${portal.name}]    If a Cloudflare challenge is showing, solve it in the browser.`);

    const formSelectors = [
        'input[placeholder*="From"]', 'input[placeholder*="Origin"]',
        'input[name="origin"]', 'input[name="departureCity"]',
        '[formcontrolname="origin"]', '#origin', '#from',
        'input[placeholder*="Departure"]', '[aria-label*="Origin"]',
    ];

    let formFound = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        for (const sel of formSelectors) {
            const el = await page.$(sel).catch(() => null);
            if (el) { formFound = true; break; }
        }
        if (formFound) break;
        await new Promise(r => setTimeout(r, 1500));
        process.stdout.write('.');
    }
    console.log('');

    if (!formFound) {
        console.warn(`[${portal.name}] Search form not detected after 90s — capturing whatever is on screen.`);
    } else {
        console.log(`[${portal.name}] ✓ Search form detected. Waiting 3s for full render...`);
        await new Promise(r => setTimeout(r, 3000));
    }

    // ── Screenshot ────────────────────────────────────────────────────────────
    const screenshotPath = path.join(ROOT, `discovery-${portal.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[${portal.name}] Screenshot → ${screenshotPath}`);

    // ── HTML dump ─────────────────────────────────────────────────────────────
    const html = await page.content();
    const htmlPath = path.join(ROOT, `discovery-${portal.name}.html`);
    fs.writeFileSync(htmlPath, html);
    console.log(`[${portal.name}] HTML dump → ${htmlPath}`);

    // ── Extract all interactive elements ──────────────────────────────────────
    const elements = await page.evaluate(() => {
        const tags = 'input, select, textarea, button, [role="button"], [role="combobox"], [role="listbox"], [role="option"], [role="tab"], [tabindex]';
        return Array.from(document.querySelectorAll(tags)).map(el => {
            const dataAttrs = {};
            for (const attr of el.attributes) {
                if (attr.name.startsWith('data-') || attr.name.startsWith('ng') ||
                    attr.name.startsWith('formcontrol') || attr.name.startsWith('aria-')) {
                    dataAttrs[attr.name] = attr.value;
                }
            }
            return {
                tag:         el.tagName.toLowerCase(),
                type:        el.type || null,
                id:          el.id   || null,
                name:        el.name || null,
                class:       el.className || null,
                placeholder: el.placeholder || null,
                value:       ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())
                                ? (el.value || null)
                                : null,
                text:        el.innerText?.trim().substring(0, 80) || null,
                visible:     el.offsetWidth > 0 && el.offsetHeight > 0,
                dataAttrs,
            };
        });
    });

    // ── Save results JSON ─────────────────────────────────────────────────────
    const outputPath = path.join(ROOT, `discovery-${portal.name}.json`);
    const output = {
        portal:   portal.name,
        url:      portal.url,
        captured: new Date().toISOString(),
        elements: {
            total:   elements.length,
            visible: elements.filter(e => e.visible).length,
            items:   elements,
        },
        network: {
            requests:  capturedRequests,
            responses: capturedResponses,
        },
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`[${portal.name}] Elements JSON → ${outputPath}`);
    console.log(`[${portal.name}] Found ${elements.length} elements (${elements.filter(e => e.visible).length} visible)`);
    console.log(`[${portal.name}] Captured ${capturedResponses.length} network response(s)`);

    // ── Print a quick summary of visible form fields ───────────────────────────
    const visible = elements.filter(e => e.visible && ['input', 'select', 'button'].includes(e.tag));
    if (visible.length > 0) {
        console.log(`\n[${portal.name}] Visible form elements summary:`);
        visible.slice(0, 20).forEach(e => {
            const attrs = [
                e.id          ? `id="${e.id}"` : null,
                e.name        ? `name="${e.name}"` : null,
                e.placeholder ? `placeholder="${e.placeholder}"` : null,
                e.type        ? `type="${e.type}"` : null,
                Object.keys(e.dataAttrs).length > 0
                    ? Object.entries(e.dataAttrs).map(([k, v]) => `${k}="${v}"`).join(' ')
                    : null,
            ].filter(Boolean).join(' ');
            console.log(`  <${e.tag} ${attrs}> ${e.text ? `"${e.text}"` : ''}`);
        });
    }

    await browser.close();
    return output;
}

async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Crane IBE Selector Discovery Tool     ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('Output files will be saved to the project root:');
    console.log('  discovery-{portal}.json   — element list + network calls');
    console.log('  discovery-{portal}.html   — full page HTML');
    console.log('  discovery-{portal}.png    — full-page screenshot');
    console.log('');
    console.log('Share the .json files so selectors can be confirmed in');
    console.log('lib/portals/adapters/crane-ibe-adapter.js');
    console.log('');

    const results = {};
    for (const portal of PORTALS) {
        try {
            results[portal.name] = await discoverPortal(portal);
        } catch (err) {
            console.error(`[${portal.name}] Discovery FAILED: ${err.message}`);
            results[portal.name] = { error: err.message };
        }
    }

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   Discovery Complete                     ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    for (const portal of PORTALS) {
        const r = results[portal.name];
        if (r?.error) {
            console.log(`  ${portal.name}: FAILED — ${r.error}`);
        } else {
            console.log(`  ${portal.name}: ${r?.elements?.total || 0} elements, ${r?.network?.responses?.length || 0} network responses`);
        }
    }
    console.log('');
}

main().catch(err => {
    console.error('Discovery script error:', err);
    process.exit(1);
});
