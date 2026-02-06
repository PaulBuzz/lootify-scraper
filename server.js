const express = require('express');
const { scrapeStock } = require('./scraper-hybrid');

const app = express();
const PORT = process.env.PORT || 3000;

// Add CORS headers to allow requests from anywhere
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

// --- Config ---
const SCRAPE_INTERVAL_MS = 12000; // 12 seconds (game restocks every 5 min, so this is plenty)
const STALE_THRESHOLD_MS = 60000; // if cache is >60s old, mark as stale in response

// --- Cache ---
let cache = {
    data: null,        // last successful scrape result
    lastScraped: null, // Date of last successful scrape
    scrapeCount: 0,    // total successful scrapes since start
    errors: 0,         // total scrape errors since start
    isRunning: false   // is a scrape currently in progress?
};

// --- Scrape loop ---
async function runScrape() {
    if (cache.isRunning) {
        console.log('[server] Scrape already in progress, skipping.');
        return;
    }
    cache.isRunning = true;

    try {
        console.log('[server] Starting scrape...');
        const data = await scrapeStock();

        // Only update cache if we actually got items
        const totalItems =
            (data.seedsStock?.length || 0) +
            (data.gearStock?.length || 0) +
            (data.eggStock?.length || 0) +
            (data.cosmeticsStock?.length || 0) +
            (data.eventStock?.length || 0) +
            (data.merchantsStock?.length || 0);

        if (totalItems > 0) {
            cache.data = data;
            cache.lastScraped = new Date();
            cache.scrapeCount++;
            console.log(`[server] ✅ Scrape successful — ${totalItems} total items cached.`);
        } else {
            console.warn('[server] ⚠ Scrape returned 0 items. Cache unchanged.');
            cache.errors++;
        }
    } catch (err) {
        console.error('[server] ❌ Scrape failed:', err.message);
        cache.errors++;
    } finally {
        cache.isRunning = false;
    }
}

// --- Routes ---

// Main stock endpoint — this is what Lootify calls
app.get('/stock', (req, res) => {
    if (!cache.data) {
        return res.status(503).json({
            error: 'No data available yet. Scraper is warming up.',
            lastScraped: null
        });
    }

    const age = Date.now() - cache.lastScraped.getTime();
    const isStale = age > STALE_THRESHOLD_MS;

    res.json({
        ...cache.data,
        _meta: {
            stale: isStale,
            ageSeconds: Math.round(age / 1000),
            lastScraped: cache.lastScraped.toISOString()
        }
    });
});

// Health check — useful for Railway/Render keep-alive and monitoring
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime().toFixed(1) + 's',
        scrapes: cache.scrapeCount,
        errors: cache.errors,
        lastScraped: cache.lastScraped?.toISOString() || null,
        hasData: !!cache.data,
        isCurrentlyScraping: cache.isRunning
    });
});

// Debug: see raw cached data structure
app.get('/debug', (req, res) => {
    res.json(cache);
});

// --- Start ---
app.listen(PORT, () => {
    console.log(`[server] 🚀 Lootify Stock Scraper running on port ${PORT}`);
    console.log(`[server] Scraping every ${SCRAPE_INTERVAL_MS / 1000}s from gamersberg.com`);

    // Run first scrape immediately, then start the interval
    runScrape();
    setInterval(runScrape, SCRAPE_INTERVAL_MS);
});
