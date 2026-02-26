const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');

// Proxy servers for IP rotation (add more as you spin up EC2s)
const PROXY_PORT = 3128;
const PROXIES = (process.env.PROXY_LIST || '').split(',').map(p => p.trim()).filter(Boolean);

const BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--window-size=1920,1080'
];

/**
 * Initialize a browser pool — one per proxy + one direct (no proxy).
 * @returns {Promise<{browsers: import('puppeteer').Browser[], getNext: () => import('puppeteer').Browser}>}
 */
async function initBrowser() {
    const browsers = [];

    // Direct browser (no proxy, uses main EC2 IP)
    console.log('[Scraper] Launching direct browser...');
    browsers.push(await puppeteer.launch({ headless: 'new', args: BROWSER_ARGS }));

    // One browser per proxy
    for (const proxy of PROXIES) {
        console.log(`[Scraper] Launching browser with proxy ${proxy}...`);
        try {
            browsers.push(await puppeteer.launch({
                headless: 'new',
                args: [...BROWSER_ARGS, `--proxy-server=http://${proxy}:${PROXY_PORT}`],
            }));
        } catch (err) {
            console.error(`[Scraper] Failed to launch browser for proxy ${proxy}:`, err.message);
        }
    }

    console.log(`[Scraper] Browser pool ready: ${browsers.length} browsers`);

    let index = 0;
    return {
        browsers,
        getNext() {
            const b = browsers[index % browsers.length];
            index++;
            return b;
        },
    };
}

/**
 * Check if an image URL is valid and accessible via a HEAD request.
 * @param {string} url 
 * @returns {Promise<boolean>}
 */
async function validateImage(url) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, { method: 'HEAD', timeout: 3000 }, (res) => {
            if (res.statusCode === 200 && res.headers['content-type']?.startsWith('image/')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}

/**
 * Scrape Google Images for a given query using an existing browser instance.
 * @param {import('puppeteer').Browser} browser - The shared browser instance.
 * @param {string} query - The search query.
 * @param {number} maxImages - Maximum number of image URLs to return (default 20).
 * @returns {Promise<string[]>} Array of image URLs.
 */
async function scrapeGoogleImages(browser, query, maxImages = 20) {
    let page;
    try {
        page = await browser.newPage();

        // 1. Optimization: Block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set a realistic user agent
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setViewport({ width: 1920, height: 1080 });

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`;
        console.log(`[Scraper] Navigating to: ${searchUrl}`);

        // 2. Optimization: Fail fast if network is slow
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        console.log('[Scraper] Page loaded.');

        // Handle consent if present (fast check)
        try {
            const consentButton = await page.$('button[aria-label="Accept all"]'); // adjust selector based on locale/update
             if (consentButton) {
                console.log('[Scraper] Clicking consent button...');
                await consentButton.click();
                 // small wait for navigation/reload
                await new Promise(r => setTimeout(r, 500)); 
            }
        } catch (e) {}


        // 3. Optimization: Fast Scroll
        console.log('[Scraper] Scrolling...');
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 500; // larger scroll distance
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    // Stop sooner if we have enough content presumably
                    if (totalHeight >= document.body.scrollHeight || totalHeight > 5000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 50); // faster interval
            });
        });
        console.log('[Scraper] Scroll complete.');

        // Get page content
        const html = await page.content();
        await page.close(); // Close page as soon as we have HTML

        // Strategy: Regex extraction from page source
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
                !url.includes('favicon') &&
                !url.includes('logo')
            ) {
                candidateUrls.add(url);
            }
        }

        console.log(`[Scraper] Found ${candidateUrls.size} candidates. Validating...`);

        // 4. Optimization: Parallel Validation (Node.js side)
        const candidates = Array.from(candidateUrls);
        const verifiedUrls = [];
        
        // Process in batches
        const BATCH_SIZE = 20;
        for (let i = 0; i < candidates.length && verifiedUrls.length < maxImages; i += BATCH_SIZE) {
             const chunk = candidates.slice(i, i + BATCH_SIZE);
             const results = await Promise.all(chunk.map(url => validateImage(url).then(isValid => {
                 if (!isValid) {
                     // console.log(`[Scraper] Invalid: ${url}`);
                 }
                 return isValid ? url : null;
             })));
             
             for (const res of results) {
                 if (res && verifiedUrls.length < maxImages) {
                     verifiedUrls.push(res);
                 }
             }
        }
        
        console.log(`[Scraper] Validated ${verifiedUrls.length} images.`);
        return verifiedUrls;

    } catch (error) {
        console.error('[Scraper] Error:', error);
        if (page && !page.isClosed()) await page.close();
        return [];
    }
}

// CLI usage (needs adjustment for browser lifecycle, keeping simple for now)
if (require.main === module) {
  (async () => {
      const query = process.argv[2];
      if (!query) {
        console.error('Usage: node scraper.js <query>');
        process.exit(1);
      }
      const count = parseInt(process.argv[3]) || 20;
      
      const browser = await initBrowser();
      try {
          const urls = await scrapeGoogleImages(browser, query, count);
          console.log(JSON.stringify(urls, null, 2));
      } finally {
          await browser.close();
      }
  })();
}

module.exports = { initBrowser, scrapeGoogleImages };
