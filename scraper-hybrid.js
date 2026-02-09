const puppeteer = require('puppeteer');

const PAGE_URL = 'https://www.gamersberg.com/grow-a-garden/stock';
const API_URL = 'https://www.gamersberg.com/api/v1/grow-a-garden/stock';
const VULCAN_API = 'https://vulcanvalues.com/api/grow-a-garden/stock';

let browserInstance = null;
let cookieString = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
    }
    return browserInstance;
}

async function refreshCookies() {
    console.log('[scraper] Refreshing session cookies...');
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );

    try {
        // Load the page to establish a session
        await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a bit for any auth to complete
        await new Promise(r => setTimeout(r, 2000));

        // Grab all cookies
        const cookies = await page.cookies();
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        console.log('[scraper] ✅ Session cookies refreshed');

    } finally {
        await page.close();
    }
}

async function scrapeStock() {
    try {
        // Refresh cookies if we don't have any, or every 30 minutes
        if (!cookieString || Math.random() < 0.05) {  // 5% chance to refresh = ~every 4 min
            await refreshCookies();
        }

        console.log('[scraper] Fetching from APIs...');

        const fetch = (await import('node-fetch')).default;

        // Fetch images from growagarden.gg (in parallel with other requests)
        let imageData = {};
        const imagePromise = (async () => {
            try {
                const imgRes = await fetch('https://growagarden.gg/api/stock', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    },
                    timeout: 8000  // 8 second timeout
                });
                if (imgRes.ok) {
                    const imgData = await imgRes.json();
                    if (imgData.imageData) {
                        imageData = imgData.imageData;
                        console.log('[scraper] ✅ Images fetched:', Object.keys(imageData).length);
                    }
                }
            } catch (err) {
                console.warn('[scraper] ⚠ Image fetch failed:', err.message);
            }
        })();

        // Fetch timers from Vulcan (no auth needed, always accurate)
        let vulcanTimers = null;
        const vulcanPromise = (async () => {
            try {
                const vulcanRes = await fetch(VULCAN_API, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                if (vulcanRes.ok) {
                    const vulcanData = await vulcanRes.json();
                    if (vulcanData.success && vulcanData.data) {
                        vulcanTimers = {
                            seeds: vulcanData.data.seedsTimer * 1000 || 300000,
                            gears: vulcanData.data.gearTimer * 1000 || 300000,
                            eggs: vulcanData.data.eggsTimer * 1000 || 1800000,
                            event: vulcanData.data.eventTimer * 1000 || 300000,
                            // Cosmetics: Vulcan might not have this, use 3h as fallback
                            cosmetics: 10800000  // 3 hours
                        };
                        console.log('[scraper] ✅ Vulcan timers fetched');
                    }
                }
            } catch (err) {
                console.warn('[scraper] ⚠ Vulcan fetch failed, using defaults:', err.message);
            }
        })();

        // Fetch stock data from gamersberg
        const response = await fetch(API_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Cookie': cookieString,
                'Referer': PAGE_URL
            }
        });

        if (response.status === 401 || response.status === 403) {
            // Session expired, refresh and retry
            console.log('[scraper] Session expired, refreshing...');
            await refreshCookies();

            // Retry with new cookies
            const response2 = await fetch(API_URL, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Cookie': cookieString,
                    'Referer': PAGE_URL
                }
            });

            if (!response2.ok) {
                throw new Error(`API returned ${response2.status}: ${response2.statusText}`);
            }

            const json = await response2.json();

            // Wait for images and vulcan to finish
            await Promise.all([imagePromise, vulcanPromise]);

            return transformData(json, vulcanTimers, imageData);
        }

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const json = await response.json();

        // Wait for images and vulcan to finish
        await Promise.all([imagePromise, vulcanPromise]);

        return transformData(json, vulcanTimers, imageData);

    } catch (error) {
        console.error('[scraper] ❌ Fetch failed:', error.message);
        throw error;
    }
}

function transformData(json, vulcanTimers, imageData = {}) {
    if (!json.success || !json.data || json.data.length === 0) {
        throw new Error('API returned unsuccessful or empty data');
    }

    const apiData = json.data[0];

    // Transform to Lootify format
    const result = {
        seedsStock: [],
        gearStock: [],
        eggStock: [],
        cosmeticsStock: [],
        eventStock: [],
        merchantsStock: [],
        restockTimers: {},
        weather: null,
        zenEvent: null,
        imageData: imageData,  // Add images to result!
        lastUpdated: new Date(apiData.timestamp * 1000).toISOString()
    };

    // Extract weather info
    if (apiData.weather) {
        result.weather = {
            type: apiData.weather.type,
            duration: apiData.weather.duration  // seconds
        };
    }

    // Calculate zen event timer (stored in seasonpass or separate field)
    // The zen event info is usually displayed on the page but might not be in API
    // We'll need to check what field it's in - for now, placeholder
    result.zenEvent = {
        active: false,  // Would need to determine from API
        timeRemaining: null  // Would need to extract from API
    };

    // Seeds
    if (apiData.seeds) {
        for (const [name, qty] of Object.entries(apiData.seeds)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.seedsStock.push({ name, value: quantity });
            }
        }
    }

    // Gear
    if (apiData.gear) {
        for (const [name, qty] of Object.entries(apiData.gear)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.gearStock.push({ name, value: quantity });
            }
        }
    }

    // Eggs
    if (apiData.eggs) {
        for (const egg of apiData.eggs) {
            if (egg.quantity > 0) {
                result.eggStock.push({ name: egg.name, value: egg.quantity });
            }
        }
    }

    // Cosmetics
    if (apiData.cosmetic) {
        for (const [name, qty] of Object.entries(apiData.cosmetic)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.cosmeticsStock.push({ name, value: quantity });
            }
        }
    }

    // Event items
    if (apiData.event) {
        for (const [name, qty] of Object.entries(apiData.event)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.eventStock.push({ name, value: quantity });
            }
        }
    }

    if (apiData.honeyevent) {
        for (const [name, qty] of Object.entries(apiData.honeyevent)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.eventStock.push({ name, value: quantity });
            }
        }
    }

    // Traveling merchant
    if (apiData.traveling) {
        for (const [name, qty] of Object.entries(apiData.traveling)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.merchantsStock.push({ name, value: quantity });
            }
        }
    }

    // Season pass items
    if (apiData.seasonpass) {
        for (const [name, qty] of Object.entries(apiData.seasonpass)) {
            const quantity = parseInt(qty);
            if (quantity > 0) {
                result.merchantsStock.push({ name, value: quantity });
            }
        }
    }

    // Restock timers - use Vulcan if available, otherwise defaults
    result.restockTimers = vulcanTimers || {
        seeds: 300000,
        gears: 300000,
        eggs: 1800000,
        cosmetics: 10800000,  // 3 hours
        event: 300000
    };

    console.log('[scraper] ✅ API fetch successful');
    console.log(`[scraper] Items: Seeds=${result.seedsStock.length}, Gear=${result.gearStock.length}, Eggs=${result.eggStock.length}, Cosmetics=${result.cosmeticsStock.length}, Event=${result.eventStock.length}, Merchant=${result.merchantsStock.length}`);
    console.log(`[scraper] Images: ${Object.keys(imageData).length} fetched`);
    console.log(`[scraper] Weather: ${result.weather?.type || 'unknown'}, Timers: seeds=${Math.floor(result.restockTimers.seeds / 60000)}m, eggs=${Math.floor(result.restockTimers.eggs / 60000)}m, cosmetics=${Math.floor(result.restockTimers.cosmetics / 3600000)}h`);

    return result;
}

module.exports = { scrapeStock };
