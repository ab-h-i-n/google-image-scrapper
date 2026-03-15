const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');

puppeteer.use(StealthPlugin());

const CHROME_PATH = '/usr/bin/google-chrome';
const BASE_DEBUG_PORT = 9222;
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3128');
const PROXIES = (process.env.PROXY_LIST || '').split(',').map(p => p.trim()).filter(Boolean);
// If DISPLAY is set (e.g. :99 from Xvfb service), Chrome runs non-headless on that display.
// Otherwise, use xvfb-run to wrap each Chrome process.
const HAS_DISPLAY = !!process.env.DISPLAY;

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
    // If DISPLAY env is set (Xvfb service running), Chrome uses it directly.
    // Otherwise, wrap with xvfb-run.
    let command, commandArgs, env;
    if (HAS_DISPLAY) {
        command = CHROME_PATH;
        commandArgs = args;
        env = { ...process.env };
    } else {
        command = 'xvfb-run';
        commandArgs = ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', CHROME_PATH, ...args];
        env = { ...process.env };
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
    return { browser, page, label, chromeProcess, debugPort, captchaCount: 0, lastUsed: 0 };
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

        getNext() {
            // Pick the entry with the lowest captchaCount, breaking ties by round-robin
            let best = null;
            for (let i = 0; i < pool.length; i++) {
                const candidate = pool[(index + i) % pool.length];
                if (!best || candidate.captchaCount < best.captchaCount) {
                    best = candidate;
                }
            }
            index++;
            // Enforce minimum delay between uses of the same entry
            const now = Date.now();
            const timeSinceLast = now - best.lastUsed;
            if (timeSinceLast < 2000) {
                // tiny pause to avoid hammering the same IP
            }
            best.lastUsed = now;
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
        const req = client.request(url, { method: 'HEAD', timeout: 3000 }, (res) => {
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
async function isCaptchaPage(page) {
    const url = page.url();
    if (url.includes('/sorry/')) return true;
    const content = await page.content();
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
 * Navigate to Google Images by typing query + clicking Images tab.
 */
async function navigateToImageSearch(page, query) {
    const currentUrl = page.url();
    if (!currentUrl.includes('google.com') || currentUrl.includes('/sorry/')) {
        await page.goto('https://www.google.com/', { waitUntil: 'networkidle2', timeout: 15000 });
        await randomDelay(1000, 2000);
    }

    const searchSelector = 'textarea[name="q"], input[name="q"]';
    const searchInput = await page.$(searchSelector);
    if (!searchInput) throw new Error('Could not find search input');

    await searchInput.click({ clickCount: 3 });
    await randomDelay(200, 400);
    await humanType(page, searchSelector, query);
    await randomDelay(500, 1000);

    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 2000);

    if (await isCaptchaPage(page)) return false;

    // Click Images tab
    const clicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const imgLink = links.find(a =>
            a.textContent.trim() === 'Images' ||
            a.href?.includes('tbm=isch') ||
            a.href?.includes('udm=2')
        );
        if (imgLink) { imgLink.click(); return true; }
        return false;
    });

    if (clicked) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await randomDelay(1000, 2000);
    } else {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&udm=2`, {
            waitUntil: 'domcontentloaded', timeout: 15000,
        });
        await randomDelay(1000, 2000);
    }

    return !(await isCaptchaPage(page));
}

/**
 * Scrape Google Images for a given query.
 */
async function scrapeGoogleImages(entry, query, maxImages = 20) {
    const { page } = entry;
    try {
        console.log(`[Scraper] Searching: "${query}" via ${entry.label}`);

        // Add delay between requests on the same entry
        await randomDelay(1000, 3000);

        const success = await navigateToImageSearch(page, query);

        if (!success) {
            console.warn(`[Scraper] CAPTCHA on ${entry.label}`);
            entry.captchaCount++;

            // Wait before retry
            const waitTime = 15000 + Math.random() * 15000;
            console.log(`[Scraper] Waiting ${Math.round(waitTime / 1000)}s...`);
            await new Promise(r => setTimeout(r, waitTime));

            await page.goto('https://www.google.com/', { waitUntil: 'networkidle2', timeout: 15000 });
            await randomDelay(2000, 4000);

            if (!(await navigateToImageSearch(page, query))) {
                console.error(`[Scraper] CAPTCHA persists on ${entry.label}`);
                return [];
            }
            entry.captchaCount = Math.max(0, entry.captchaCount - 1);
        }

        console.log(`[Scraper] Images page: ${page.url()}`);

        // Scroll a few times to load more images
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, 1500));
            await randomDelay(800, 1500);
        }

        // Extract image URLs
        const html = await page.content();
        const regex = /(?:https?:\/\/|https?:\\\/\\\/)[^"'\s\\]+\.(?:jpg|jpeg|png|gif|webp)/gi;

        const candidateUrls = new Set();
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
                candidateUrls.add(url);
            }
        }

        console.log(`[Scraper] ${candidateUrls.size} candidates. Validating...`);

        const candidates = Array.from(candidateUrls);
        const verifiedUrls = [];

        const BATCH_SIZE = 20;
        for (let i = 0; i < candidates.length && verifiedUrls.length < maxImages; i += BATCH_SIZE) {
            const chunk = candidates.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(chunk.map(url =>
                validateImage(url).then(ok => ok ? url : null)
            ));

            for (const res of results) {
                if (res && verifiedUrls.length < maxImages) verifiedUrls.push(res);
            }
        }

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
            const urls = await scrapeGoogleImages(entry, query, count);
            console.log(JSON.stringify(urls, null, 2));
        } finally {
            await pool.shutdown();
        }
    })();
}

module.exports = { initBrowser, scrapeGoogleImages };
