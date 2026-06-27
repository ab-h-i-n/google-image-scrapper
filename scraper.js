const https = require('https');
const http = require('http');

// Browser-like identity for search-engine requests.
const USER_AGENT = process.env.SCRAPER_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Per-request tuning (all overridable via env).
const VALIDATE_TIMEOUT_MS = parseInt(process.env.VALIDATE_TIMEOUT_MS || '1200');
const VALIDATE_CONCURRENCY = parseInt(process.env.VALIDATE_CONCURRENCY || '60');
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '12000');

// Keep-alive agents so repeated HEAD validations to the same CDN reuse sockets
// instead of re-handshaking on every request.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: VALIDATE_CONCURRENCY });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: VALIDATE_CONCURRENCY });

/**
 * Fetch a URL's body as text with browser-like headers. Uses the global `fetch`
 * (Node 18+), which transparently follows redirects and decodes gzip/brotli.
 */
async function fetchText(url, extraHeaders = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: ac.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...extraHeaders,
            },
        });
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * DuckDuckGo image search (primary source). Two-step: fetch the page to mint a
 * per-query `vqd` token, then hit the i.js JSON API. Returns full-resolution
 * candidate image URLs in DDG's relevance order. No browser / no CAPTCHA wall.
 */
async function scrapeDuckDuckGo(query) {
    const q = encodeURIComponent(query);

    // 1) Mint the per-query vqd token from the results page.
    const tokenHtml = await fetchText(`https://duckduckgo.com/?q=${q}&iar=images&iax=images&ia=images`);
    const m = tokenHtml.match(/vqd=["']?([\d-]+)["']?/);
    if (!m) throw new Error('vqd token not found');
    const vqd = m[1];

    // 2) Fetch the image results JSON.
    const body = await fetchText(
        `https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`,
        {
            'Referer': 'https://duckduckgo.com/',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
        },
    );
    let data;
    try { data = JSON.parse(body); } catch (e) { throw new Error('DDG JSON parse failed'); }
    const results = Array.isArray(data.results) ? data.results : [];
    const urls = results.map(r => r.image).filter(u => typeof u === 'string' && u.startsWith('http'));
    return Array.from(new Set(urls));
}

/**
 * Bing image search (fallback source). Full-resolution URLs live in the `murl`
 * field of each result's HTML-entity-encoded `m="{...}"` attribute.
 */
async function scrapeBing(query) {
    const q = encodeURIComponent(query);
    const html = await fetchText(`https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1`);
    const set = new Set();
    const re = /murl&quot;:&quot;(.*?)&quot;/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const url = m[1].replace(/&amp;/g, '&');
        if (url.startsWith('http')) set.add(url);
    }
    return Array.from(set);
}

/**
 * Check if an image URL is valid via HEAD request. Optional AbortSignal lets the
 * caller cancel in-flight checks once it already has enough results. Third-party
 * URLs may be malformed, so the request construction is guarded.
 */
async function validateImage(url, signal) {
    return new Promise((resolve) => {
        let req;
        try {
            const isHttps = url.startsWith('https');
            const client = isHttps ? https : http;
            const opts = { method: 'HEAD', timeout: VALIDATE_TIMEOUT_MS, agent: isHttps ? httpsAgent : httpAgent };
            if (signal) opts.signal = signal;
            req = client.request(url, opts, (res) => {
                resolve(res.statusCode === 200 && res.headers['content-type']?.startsWith('image/'));
            });
        } catch (e) {
            return resolve(false);
        }
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

/**
 * Validate candidates concurrently and resolve as soon as `maxImages` live images
 * are confirmed (returned in source rank order), aborting the rest. Live CDN
 * images answer in <400ms, so this avoids blocking on dead/slow URLs that would
 * otherwise each burn up to VALIDATE_TIMEOUT_MS. Overscans (vs the few we need) so
 * a low live-rate still fills the result without a second serial wave.
 */
async function collectValidImages(candidates, maxImages) {
    if (candidates.length === 0) return [];
    const cap = Math.min(candidates.length, Math.max(maxImages * 6, 48), 96);
    const pool = candidates.slice(0, cap);
    return new Promise((resolve) => {
        const controllers = [];
        const live = [];
        let settled = 0, done = false;
        const finish = () => {
            if (done) return;
            done = true;
            for (const c of controllers) { try { c.abort(); } catch (e) {} }
            live.sort((a, b) => a.idx - b.idx);
            resolve(live.slice(0, maxImages).map(x => x.url));
        };
        pool.forEach((url, idx) => {
            const ac = new AbortController();
            controllers.push(ac);
            validateImage(url, ac.signal).then((ok) => {
                if (done) return;
                if (ok) live.push({ idx, url });
                settled++;
                if (live.length >= maxImages || settled >= pool.length) finish();
            });
        });
    });
}

/**
 * Scrape images for a query: DuckDuckGo first, Bing as fallback. Returns up to
 * `maxImages` validated, live image URLs in source-relevance order.
 */
async function scrapeImages(query, maxImages = 20) {
    const sources = [
        { name: 'duckduckgo', fn: scrapeDuckDuckGo },
        { name: 'bing', fn: scrapeBing },
    ];
    for (const src of sources) {
        try {
            const candidates = await src.fn(query);
            console.log(`[Scraper] ${src.name}: ${candidates.length} candidates for "${query}"`);
            if (!candidates.length) continue;
            const valid = await collectValidImages(candidates, maxImages);
            console.log(`[Scraper] ${src.name}: ${valid.length} validated`);
            if (valid.length) return valid;
        } catch (e) {
            console.error(`[Scraper] ${src.name} failed: ${e.message}`);
        }
    }
    return [];
}

// CLI usage: node scraper.js <query> [count]
if (require.main === module) {
    (async () => {
        const query = process.argv[2];
        if (!query) {
            console.error('Usage: node scraper.js <query> [count]');
            process.exit(1);
        }
        const count = parseInt(process.argv[3]) || 20;
        const urls = await scrapeImages(query, count);
        console.log(JSON.stringify(urls, null, 2));
    })();
}

module.exports = { scrapeImages };
