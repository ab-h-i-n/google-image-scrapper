const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeImages } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache
const cache = new Map();
const CACHE_TTL = 3600 * 1000; // 1 hour

// API endpoint: GET /api/search?q=query&count=20
app.get('/api/search', async (req, res) => {
  const { q, count } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing required query parameter "q"' });
  }

  const maxImages = Math.min(parseInt(count) || 20, 50);
  const cacheKey = `${q.trim().toLowerCase()}_${maxImages}`;

  // Check cache
  if (cache.has(cacheKey)) {
      const { timestamp, data } = cache.get(cacheKey);
      if (Date.now() - timestamp < CACHE_TTL) {
          console.log(`[Server] Serving from cache: "${q}"`);
          return res.json(data);
      } else {
          cache.delete(cacheKey);
      }
  }

  console.log(`[Server] Search request: "${q}" (max ${maxImages} images)`);

  try {
    const images = await scrapeImages(q.trim(), maxImages);
    const responseData = { query: q.trim(), count: images.length, images };

    // Set cache (only successful, non-empty results)
    if (images.length > 0) {
        cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
    }

    res.json(responseData);
  } catch (err) {
    console.error('[Server] Scrape error:', err.message);
    res.status(500).json({ error: 'Failed to scrape images. Please try again.' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n🔍 Image Scraper (DuckDuckGo + Bing) running at http://localhost:${PORT}\n`);
});
// Keep idle connections open (default keepAliveTimeout is only 5s) so a pooling
// caller reuses sockets instead of re-handshaking on every request.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Graceful shutdown
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
