const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');

puppeteer.use(StealthPlugin());

const CHROME_PATH = process.env.CHROME_PATH || (
    process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/google-chrome'
);
const BASE_DEBUG_PORT = 9222;
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3128');
const PROXIES = (process.env.PROXY_LIST || '').split(',').map(p => p.trim()).filter(Boolean);
// If DISPLAY is set (e.g. :99 from Xvfb service), Chrome runs non-headless on that display.
// Otherwise, use xvfb-run to wrap each Chrome process.
const HAS_DISPLAY = !!process.env.DISPLAY;

// Per-request performance tuning (all overridable via env).
// Image validation: fire HEAD requests concurrently with a short timeout instead
// of long sequential batches — most live images answer in <500ms.
const VALIDATE_TIMEOUT_MS = parseInt(process.env.VALIDATE_TIMEOUT_MS || '1200');
const VALIDATE_CONCURRENCY = parseInt(process.env.VALIDATE_CONCURRENCY || '60');
// Minimum spacing between two consecutive scrapes on the SAME browser/IP. Small,
// just to avoid hammering one IP under load — not the old multi-second anti-bot tax.
const MIN_ENTRY_SPACING_MS = parseInt(process.env.MIN_ENTRY_SPACING_MS || '300');
// When an entry hits a CAPTCHA, sideline it for this long and fail over to another
// IP instead of sleeping inline.
const CAPTCHA_COOLDOWN_MS = parseInt(process.env.CAPTCHA_COOLDOWN_MS || '300000'); // 5 min

function randomDelay(min = 1000, max = 3000) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

/**
 * Launch a Chrome process with optional proxy support.
 * Each instance gets its own debug port and user data dir.
 */
function launchChrome(debugPort, label, proxyUrl) {
    const userDataDir = path.join(os.homedir(), `.chrome-scraper-${label}`);
    const args = [
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-sandbox',
        '--window-size=1920,1080',
        'about:blank',
    ];

    if (proxyUrl) {
        args.splice(-1, 0, `--proxy-server=${proxyUrl}`);
    }

    // Use virtual display instead of --headless (Google detects headless mode).
    // - Linux with a DISPLAY already set (Xvfb service) → launch Chrome directly.
    // - Headless Linux (e.g. EC2) → wrap with xvfb-run for a virtual display.
    // - Desktop OS (macOS/Windows) → launch directly; the OS provides a display.
    const env = { ...process.env };
    let command, commandArgs;
    if (HAS_DISPLAY || process.platform !== 'linux') {
        command = CHROME_PATH;
        commandArgs = args;
    } else {
        command = 'xvfb-run';
        commandArgs = ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', CHROME_PATH, ...args];
    }

    const proc = spawn(command, commandArgs, { stdio: 'ignore', detached: false, env });
    proc.on('error', (err) => console.error(`[Scraper] Chrome ${label} error:`, err.message));
    return proc;
}

/**
 * Wait for a Chrome debug port to become available.
 */
async function waitForPort(port, maxWait = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const resp = await fetch(`http://localhost:${port}/json/version`);
            if (resp.ok) return true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Chrome on port ${port} did not start in time`);
}

/**
 * Create a browser entry: launch Chrome, connect Puppeteer, warm up.
 */
async function createEntry(debugPort, label, proxyUrl) {
    console.log(`[Scraper] Launching Chrome: ${label} (port ${debugPort})${proxyUrl ? ` via proxy ${proxyUrl}` : ''}...`);
    const chromeProcess = launchChrome(debugPort, label, proxyUrl);
    await waitForPort(debugPort);

    const browser = await puppeteer.connect({
        browserURL: `http://localhost:${debugPort}`,
        defaultViewport: null,
        protocolTimeout: 120000,
    });

    let pages = await browser.pages();
    let page = pages[0] || await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Warm up
    console.log(`[Scraper] Warming up ${label}...`);
    await page.goto('https://www.google.com/', { waitUntil: 'networkidle2', timeout: 20000 });
    await randomDelay(1000, 2000);

    // Accept consent if present
    try {
        const btn = await page.$('button[aria-label="Accept all"], button#L2AGLb');
        if (btn) { await btn.click(); await randomDelay(500, 1000); }
    } catch (e) {}

    console.log(`[Scraper] ${label} ready`);
    return { browser, page, label, chromeProcess, debugPort, captchaCount: 0, lastUsed: 0, cooldownUntil: 0 };
}

/**
 * Initialize browser pool: one direct + one per proxy.
 */
async function initBrowser() {
    const pool = [];
    let portOffset = 0;

    // Direct browser (no proxy, uses EC2's own IP)
    try {
        pool.push(await createEntry(BASE_DEBUG_PORT + portOffset, 'direct', null));
        portOffset++;
    } catch (err) {
        console.error('[Scraper] Failed to launch direct browser:', err.message);
    }

    // One browser per proxy
    for (const proxy of PROXIES) {
        try {
            const proxyUrl = proxy.includes(':') ? `http://${proxy}` : `http://${proxy}:${PROXY_PORT}`;
            pool.push(await createEntry(BASE_DEBUG_PORT + portOffset, `proxy-${proxy}`, proxyUrl));
            portOffset++;
        } catch (err) {
            console.error(`[Scraper] Failed to launch browser for proxy ${proxy}:`, err.message);
        }
    }

    if (pool.length === 0) throw new Error('No browsers launched');
    console.log(`[Scraper] Pool ready: ${pool.length} browser(s)`);

    let index = 0;
    return {
        browsers: pool.map(p => p.browser),

        getNext(excludeLabel = null) {
            // Prefer entries that are not on CAPTCHA cooldown and have the lowest
            // captchaCount, breaking ties by round-robin. Optionally skip one label
            // (used for fail-over to a different IP).
            const now = Date.now();
            let best = null;
            for (let i = 0; i < pool.length; i++) {
                const candidate = pool[(index + i) % pool.length];
                if (excludeLabel && candidate.label === excludeLabel) continue;
                if (candidate.cooldownUntil > now) continue;
                if (!best || candidate.captchaCount < best.captchaCount) {
                    best = candidate;
                }
            }
            // Fallback: everything excluded or cooling down — pick the soonest-available.
            if (!best) {
                const usable = pool.filter(c => !excludeLabel || c.label !== excludeLabel);
                const arr = usable.length ? usable : pool;
                best = arr.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
            }
            index++;
            console.log(`[Scraper] Using: ${best.label} (captchas: ${best.captchaCount})`);
            return best;
        },

        async shutdown() {
            for (const entry of pool) {
                try { entry.browser.disconnect(); } catch (e) {}
                try { entry.chromeProcess.kill(); } catch (e) {}
            }
        },
    };
}

/**
 * Check if an image URL is valid via HEAD request.
 */
async function validateImage(url) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, { method: 'HEAD', timeout: VALIDATE_TIMEOUT_MS }, (res) => {
            resolve(res.statusCode === 200 && res.headers['content-type']?.startsWith('image/'));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

/**
 * Detect CAPTCHA page.
 */
async function isCaptchaPage(page, html = null) {
    if (page.url().includes('/sorry/')) return true;
    const content = html != null ? html : await page.content();
    return content.includes('detected unusual traffic') || content.includes('systems have detected');
}

/**
 * Type text with human-like delays.
 */
async function humanType(page, selector, text) {
    await page.click(selector);
    await randomDelay(200, 400);
    for (const char of text) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 120 });
    }
}

/**
 * Navigate to Google Images search.
 * Uses direct URL navigation (proven to work without CAPTCHA when Chrome
 * is spawned natively with Xvfb).
 */
async function navigateToImageSearch(page, query) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=2`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

/**
 * Extract candidate image URLs from a Google Images results HTML blob.
 */
function extractImageUrls(html) {
    const regex = /(?:https?:\/\/|https?:\\\/\\\/)[^"'\s\\]+\.(?:jpg|jpeg|png|gif|webp)/gi;
    const set = new Set();
    let match;
    while ((match = regex.exec(html)) !== null) {
        let url = match[0];
        try { url = JSON.parse(`"${url}"`); } catch (e) {
            url = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\u002f/g, '/');
        }
        url = url.replace(/\\\//g, '/');

        if (
            url.startsWith('http') &&
            !url.includes('google.com') &&
            !url.includes('gstatic.com') &&
            !url.includes('googleapis.com') &&
            !url.includes('favicon') &&
            !url.includes('logo')
        ) {
            set.add(url);
        }
    }
    return Array.from(set);
}

/**
 * Run an async fn over items with bounded concurrency, preserving input order.
 */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await fn(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Validate candidate URLs concurrently and return up to maxImages live ones,
 * preserving Google's relevance order. Overscans so dead links don't starve the
 * result, but bounds concurrency and falls back to remaining candidates if needed.
 */
async function collectValidImages(candidates, maxImages) {
    const out = [];
    const overscan = Math.min(candidates.length, Math.max(maxImages * 4, 24));
    const first = candidates.slice(0, overscan);
    const verdicts = await mapLimit(first, VALIDATE_CONCURRENCY, validateImage);
    for (let i = 0; i < first.length && out.length < maxImages; i++) {
        if (verdicts[i]) out.push(first[i]);
    }
    // Rare low-hit-rate fallback: validate the rest only if we still came up short.
    if (out.length < maxImages && candidates.length > overscan) {
        const rest = candidates.slice(overscan);
        const v2 = await mapLimit(rest, VALIDATE_CONCURRENCY, validateImage);
        for (let i = 0; i < rest.length && out.length < maxImages; i++) {
            if (v2[i]) out.push(rest[i]);
        }
    }
    return out;
}

/**
 * Scrape Google Images for a given query.
 */
async function scrapeGoogleImages(entry, query, maxImages = 20, pool = null) {
    const { page } = entry;
    try {
        console.log(`[Scraper] Searching: "${query}" via ${entry.label}`);

        // Light politeness: only pause if this same entry was used very recently.
        const sinceLast = Date.now() - (entry.lastUsed || 0);
        if (sinceLast < MIN_ENTRY_SPACING_MS) {
            await new Promise(r => setTimeout(r, MIN_ENTRY_SPACING_MS - sinceLast));
        }
        entry.lastUsed = Date.now();

        await navigateToImageSearch(page, query);

        // Single page.content() serves both CAPTCHA detection and URL extraction.
        let html = await page.content();

        if (await isCaptchaPage(page, html)) {
            console.warn(`[Scraper] CAPTCHA on ${entry.label} — cooling down ${Math.round(CAPTCHA_COOLDOWN_MS / 1000)}s`);
            entry.captchaCount++;
            entry.cooldownUntil = Date.now() + CAPTCHA_COOLDOWN_MS;

            // Fail over to a different IP immediately instead of sleeping inline.
            if (pool) {
                const alt = pool.getNext(entry.label);
                if (alt && alt.label !== entry.label) {
                    console.log(`[Scraper] Failing over to ${alt.label}`);
                    return scrapeGoogleImages(alt, query, maxImages, null);
                }
            }
            return [];
        }

        console.log(`[Scraper] Images page: ${page.url()}`);

        let candidates = extractImageUrls(html);

        // Only scroll for more if the first paint didn't yield enough candidates.
        if (candidates.length < maxImages * 2) {
            for (let i = 0; i < 3 && candidates.length < maxImages * 2; i++) {
                await page.evaluate(() => window.scrollBy(0, 2000));
                await new Promise(r => setTimeout(r, 350)); // brief wait for lazy-load
                html = await page.content();
                candidates = extractImageUrls(html);
            }
        }

        console.log(`[Scraper] ${candidates.length} candidates. Validating...`);
        const verifiedUrls = await collectValidImages(candidates, maxImages);
        console.log(`[Scraper] Validated ${verifiedUrls.length} images.`);
        return verifiedUrls;

    } catch (error) {
        console.error('[Scraper] Error:', error.message);
        return [];
    }
}

// CLI usage
if (require.main === module) {
    (async () => {
        const query = process.argv[2];
        if (!query) {
            console.error('Usage: node scraper.js <query>');
            process.exit(1);
        }
        const count = parseInt(process.argv[3]) || 20;

        const pool = await initBrowser();
        try {
            const entry = pool.getNext();
            const urls = await scrapeGoogleImages(entry, query, count, pool);
            console.log(JSON.stringify(urls, null, 2));
        } finally {
            await pool.shutdown();
        }
    })();
}

module.exports = { initBrowser, scrapeGoogleImages };
