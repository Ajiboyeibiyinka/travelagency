'use strict';
const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SEL_FORM = '#firstDepPort';

async function probe() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: { width: 1366, height: 768 },
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    console.log('Navigating to Air Peace search page...');
    await page.goto('https://book-airpeace.crane.aero/ibe/search', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
    }).catch(e => console.warn('goto warning:', e.message));

    async function snap(label) {
        const title = await page.title().catch(() => '?');
        const url   = page.url().slice(0, 90);
        const el    = await page.$(SEL_FORM).catch(() => null);
        const html5 = await page.evaluate(() => document.body?.innerText?.slice(0, 200)).catch(() => '');
        console.log(`\n[${label}]`);
        console.log('  Title:', title);
        console.log('  URL:  ', url);
        console.log('  Form present?', !!el);
        console.log('  Body snippet:', html5.replace(/\n/g, ' ').slice(0, 120));
        await page.screenshot({ path: `probe-${label}.png` }).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 5000));
    await snap('5s');

    await new Promise(r => setTimeout(r, 10000));
    await snap('15s');

    await new Promise(r => setTimeout(r, 15000));
    await snap('30s');

    await browser.close();
    console.log('\nDone. Check probe-5s.png / probe-15s.png / probe-30s.png');
}

probe().catch(e => { console.error('Error:', e.message); process.exit(1); });
