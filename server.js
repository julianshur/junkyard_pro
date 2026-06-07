// v7 - audit hardening: rate limiting, error states, concurrency, security, logging
import express from "express";
import axios   from "axios";
import { load as cheerioLoad } from "cheerio";
import cors    from "cors";
import path    from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app        = express();
const PORT       = process.env.PORT || 5180;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Playwright browser path: set via env var, falls back to Render's project dir
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/project/src/.playwright";

// ── Logging (timestamped) ─────────────────────────────────────────────────────
function log(tag, ...args) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args);
}

// ── Rate limiting (in-memory, no extra dependency) ────────────────────────────
const rateCounts = new Map();
function rateLimit(max, windowMs = 60000) {
  return (req, res, next) => {
    const key = `${req.ip}:${Math.floor(Date.now() / windowMs)}`;
    const n = (rateCounts.get(key) || 0) + 1;
    rateCounts.set(key, n);
    if (n === 1) setTimeout(() => rateCounts.delete(key), windowMs);
    if (n > max) return res.status(429).json({ error: "Too many requests — please wait a moment." });
    next();
  };
}

app.use(cors({ origin: "*", methods: ["GET"] }));
app.get("/test", (_, res) => res.json({ ok: true, version: 7 }));

// ── HTTP client ───────────────────────────────────────────────────────────────
const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "sec-ch-ua": '"Chromium";v="124","Google Chrome";v="124"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "Upgrade-Insecure-Requests": "1",
  },
});

// ── Cache: Upstash Redis + in-memory fallback ─────────────────────────────────
const TTL = {
  inventory: 4  * 60 * 60,      // 4 hours
  ebay:      72 * 60 * 60,      // 72 hours
  queries:   7  * 24 * 60 * 60, // 7 days
};

const memCache = new Map();
function memGet(key) {
  const e = memCache.get(key);
  if (!e || Date.now() > e.exp) { memCache.delete(key); return null; }
  return e.data;
}
function memSet(key, data, ttlSec) {
  memCache.set(key, { data, exp: Date.now() + ttlSec * 1000 });
}

const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cacheGet(key) {
  if (redisUrl && redisToken) {
    try {
      const r = await axios.get(`${redisUrl}/get/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${redisToken}` }, timeout: 3000 });
      const val = r.data?.result;
      if (val) return JSON.parse(val);
    } catch(_) {}
  }
  return memGet(key);
}

async function cacheSet(key, data, ttlSec) {
  memSet(key, data, ttlSec);
  if (redisUrl && redisToken) {
    try {
      await axios.post(`${redisUrl}/set/${encodeURIComponent(key)}`,
        { value: JSON.stringify(data), ex: ttlSec },
        { headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" }, timeout: 3000 });
    } catch(_) {}
  }
}

// ── Playwright launcher (shared config) ───────────────────────────────────────
const BROWSER_ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage", "--disable-gpu",
];
const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3] });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function launchChromium() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_PATH;
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}

// ── fetchPage ─────────────────────────────────────────────────────────────────
const cookieJar = {};
const BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

async function fetchPage(url, referer = null) {
  const domain = new URL(url).hostname;

  if (domain.includes("pyp.com")) {
    const browser = await launchChromium();
    try {
      const ctx = await browser.newContext({ userAgent: UA, locale: "en-US",
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });
      const page = await ctx.newPage();
      await page.addInitScript(STEALTH_SCRIPT);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(".pypvi_resultRow", { timeout: 25000 }).catch(() => {});
      return await page.content();
    } finally {
      await browser.close();
    }
  }

  // Direct request with cookie jar for other domains
  if (!cookieJar[domain]) {
    try {
      const r = await http.get(`https://${domain}/`, { headers: BROWSER_HEADERS, maxRedirects: 5 });
      const sc = r.headers["set-cookie"];
      cookieJar[domain] = sc ? sc.map(c => c.split(";")[0]).join("; ") : "";
    } catch(_) { cookieJar[domain] = ""; }
  }
  const headers = { ...BROWSER_HEADERS };
  if (cookieJar[domain]) headers["Cookie"] = cookieJar[domain];
  if (referer) headers["Referer"] = referer;
  const r = await http.get(url, { headers, maxRedirects: 5 });
  const sc = r.headers["set-cookie"];
  if (sc) {
    const nc = sc.map(c => c.split(";")[0]).join("; ");
    cookieJar[domain] = cookieJar[domain] ? cookieJar[domain] + "; " + nc : nc;
  }
  return r.data;
}

// ── Claude helpers ────────────────────────────────────────────────────────────
async function claudePost(prompt, system, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const r = await http.post("https://api.anthropic.com/v1/messages", {
    model: "claude-haiku-4-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 });
  return r.data.content[0].text.trim();
}

async function getSearchQueries(year, make, model) {
  const cacheKey = `queries:${year}:${make}:${model}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const fallback = [`${year} ${make} ${model} engine`];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
      const text = await claudePost(
        `For a ${year} ${make} ${model} at a self-service junkyard, what is the single most valuable part commonly resold on eBay? Focus on high-value items like engine, transmission, or a model-specific popular part.\nReturn ONLY a JSON array with 1 eBay search string. Example: ["2003 Honda Accord engine"]`,
        "You are an auto parts expert. Respond with a JSON array only — no explanation.", 100);
      if (!text) throw new Error("empty response");
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0]);
      if (!Array.isArray(arr) || !arr.length) throw new Error("invalid array");
      log("claude", `queries for ${year} ${make} ${model}:`, arr);
      await cacheSet(cacheKey, arr, TTL.queries);
      return arr;
    } catch(e) {
      log("claude", `query gen attempt ${attempt+1} failed: ${e.message}`);
    }
  }
  log("claude", `using fallback queries for ${year} ${make} ${model}`);
  return fallback;
}

async function matchAndScoreListings(listings, yardParts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !listings.length) return;

  // Process up to 100 listings (audit fix: was 40)
  const batch = listings.slice(0, 100);
  const partNames = yardParts.map(p => p.partName);
  const titlesStr = batch.map((l, i) => `${i}: ${l.title} [$${l.soldPrice}${l.soldCount ? ", " + l.soldCount + "x sold" : ""}]`).join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      const text = await claudePost(
        `Match these eBay used auto part listings to PYP junkyard categories.\nCategories: ${partNames.join(", ")}\nListings:\n${titlesStr}\nJSON format: {"0":{"category":"Engine, 4 Cyl","demand":4},"1":{"category":"NO_MATCH","demand":0}}\ndemand: 1-5 (5=high volume). NO_MATCH if unclear.`,
        "You are an auto parts expert. Respond with valid JSON only — no explanations, no markdown.", 2000);
      if (!text) throw new Error("null response");
      const start = text.indexOf("{"), end2 = text.lastIndexOf("}");
      if (start === -1 || end2 === -1) throw new Error("No JSON");
      const results = JSON.parse(text.slice(start, end2 + 1));
      let matched = 0;
      batch.forEach((l, i) => {
        const res = results[String(i)];
        if (res?.category && res.category !== "NO_MATCH") {
          const part = yardParts.find(p => p.partName.toLowerCase() === res.category.toLowerCase()) ||
                       yardParts.find(p => p.partName.toLowerCase().includes(res.category.toLowerCase().split(",")[0]));
          l.pypCategory = part ? part.partName : res.category;
          l.pypPrice    = part?.price ?? null;
          l.demand      = res.demand || 1;
          matched++;
        }
      });
      log("claude", `matched ${matched}/${batch.length}`);
      return;
    } catch(e) {
      log("claude", `match attempt ${attempt+1} failed: ${e.message}`);
    }
  }
}

function scoreYard(vehicles) {
  const HOT  = ["BMW","MERCEDES","MERCEDES-BENZ","AUDI","LEXUS","ACURA","INFINITI","PORSCHE","LAND ROVER","CADILLAC","VOLVO"];
  const GOOD = ["HONDA","TOYOTA","NISSAN","SUBARU","MAZDA","HYUNDAI","KIA","VOLKSWAGEN","FORD","CHEVY","CHEVROLET","GMC","DODGE","JEEP","RAM"];
  let score = 0;
  const yr = new Date().getFullYear();
  vehicles.forEach(v => {
    score += Math.max(0, 30 - (yr - (v.year || 2000)) * 1.5);
    const mk = (v.make || "").toUpperCase();
    if (HOT.some(m => mk.includes(m))) score += 25;
    else if (GOOD.some(m => mk.includes(m))) score += 10;
  });
  const n = Math.min(100, Math.round((score / (vehicles.length * 55)) * 100));
  return { score: n, grade: n >= 70 ? "green" : n >= 40 ? "yellow" : "red", label: n >= 70 ? "High" : n >= 40 ? "Medium" : "Low" };
}

// ── eBay scraping (fresh browser per query to avoid OOM) ─────────────────────
async function scrapeEbayQuery(q) {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
    await ctx.addInitScript(STEALTH_SCRIPT);
    // No _sacat filter — category restriction was causing 0 results
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=12&_ipg=48`;
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".s-item, .s-card", { timeout: 10000 }).catch(() => {});
    const listings = await page.evaluate(() => {
      const results = [];
      for (const card of document.querySelectorAll(".s-item, .s-card")) {
        const text = card.textContent || "";
        const titleEl = card.querySelector(".s-item__title, .s-card__title");
        const title = (titleEl?.textContent || "").replace("New listing","").replace(/Opens in a new window or tab/gi,"").trim();
        if (!title || title === "Shop on eBay") continue;
        const priceEl = card.querySelector(".s-item__price, .s-card__price");
        const priceMatch = (priceEl?.textContent || text).match(/\$([\d,]+\.\d{2})/);
        if (!priceMatch) continue;
        const price = parseFloat(priceMatch[1].replace(/,/g,""));
        if (!price || price < 1) continue;
        const linkEl = card.querySelector("a.s-item__link, a.s-card__link, a[href*='ebay.com/itm']");
        const href = linkEl?.href || "";
        if (!href || href.includes("rover.ebay.com")) continue;
        const condEl = card.querySelector(".SECONDARY_INFO, .s-item__subtitle, .s-card__subtitle");
        const condition = condEl?.textContent?.trim() || null;
        if (/^new$|^brand new$/i.test(condition||"")) continue;
        // Only record soldCount when eBay explicitly states it (audit fix: was defaulting to 1)
        const soldMatch = text.match(/(\d[\d,]*)\s+sold/i);
        results.push({
          title, soldPrice: price, url: href.split("?")[0], category: condition,
          soldCount: soldMatch ? parseInt(soldMatch[1].replace(/,/g,"")) : null,
        });
      }
      return results;
    });
    log("ebay", `"${q.slice(0,40)}" items:${listings.length}`);
    return listings;
  } finally {
    await browser.close();
  }
}

async function fetchEbayListings(searchQueries) {
  const allListings = [];
  for (const q of searchQueries) {
    try {
      const listings = await scrapeEbayQuery(q);
      allListings.push(...listings);
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      log("ebay", `query failed "${q}": ${e.message}`);
    }
  }
  const seen = new Set();
  return allListings
    .filter(l => { if (!l.url || seen.has(l.url)) return false; seen.add(l.url); return true; })
    .sort((a,b) => ((b.soldCount||0) - (a.soldCount||0)) || (b.soldPrice - a.soldPrice));
}

// ── Store & price data ────────────────────────────────────────────────────────
const KNOWN_STORES = [
  { id: "sun-valley-1263",               name: "Pick Your Part - Sun Valley",       address: "8000 Laurel Canyon Blvd, Sun Valley, CA 91352" },
  { id: "wilmington-help-yourself-1262", name: "Pick Your Part - Wilmington",       address: "1600 E Anaheim St, Wilmington, CA 90744" },
  { id: "victorville-1287",              name: "Pick Your Part - Victorville",      address: "Victorville, CA" },
  { id: "santa-fe-springs-1282",         name: "Pick Your Part - Santa Fe Springs", address: "Santa Fe Springs, CA" },
  { id: "san-bernardino-1291",           name: "Pick Your Part - San Bernardino",   address: "San Bernardino, CA" },
  { id: "riverside-1290",                name: "Pick Your Part - Riverside",        address: "Riverside, CA" },
  { id: "ontario-1280",                  name: "Pick Your Part - Ontario",          address: "Ontario, CA" },
  { id: "monrovia-1281",                 name: "Pick Your Part - Monrovia",         address: "Monrovia, CA" },
  { id: "hesperia-1292",                 name: "Pick Your Part - Hesperia",         address: "Hesperia, CA" },
  { id: "fontana-1285",                  name: "Pick Your Part - Fontana",          address: "Fontana, CA" },
  { id: "chula-vista-1264",              name: "Pick Your Part - Chula Vista",      address: "Chula Vista, CA" },
  { id: "rialto-1284",                   name: "Pick Your Part - Rialto",           address: "Rialto, CA" },
  { id: "anaheim-1265",                  name: "Pick Your Part - Anaheim",          address: "Anaheim, CA" },
];

const PYP_PRICES = [
  { partName: "Engine, 4 Cyl",        price: 275 }, { partName: "Engine, 6 Cyl",        price: 325 },
  { partName: "Engine, 8 Cyl",        price: 375 }, { partName: "Transmission, Auto",   price: 175 },
  { partName: "Transmission, Manual", price: 150 }, { partName: "Transfer Case",         price: 125 },
  { partName: "Rear Axle Assembly",   price: 125 }, { partName: "Differential",          price: 75  },
  { partName: "Drive Shaft",          price: 35  }, { partName: "Hood",                  price: 50  },
  { partName: "Door",                 price: 50  }, { partName: "Trunk Lid",             price: 45  },
  { partName: "Fender",               price: 40  }, { partName: "Bumper",                price: 35  },
  { partName: "Radiator Core Support",price: 45  }, { partName: "Radiator",              price: 35  },
  { partName: "A/C Condenser",        price: 35  }, { partName: "AC Compressor",         price: 45  },
  { partName: "Alternator",           price: 35  }, { partName: "Starter",               price: 25  },
  { partName: "Power Steering Pump",  price: 25  }, { partName: "Water Pump",            price: 20  },
  { partName: "Fuel Pump",            price: 25  }, { partName: "Fuel Tank",             price: 35  },
  { partName: "Seat, Front",          price: 35  }, { partName: "Seat, Rear",            price: 25  },
  { partName: "Dashboard",            price: 50  }, { partName: "Steering Column",       price: 35  },
  { partName: "Steering Wheel",       price: 20  }, { partName: "Tailgate",              price: 55  },
  { partName: "Truck Bed",            price: 150 }, { partName: "Wheel, Alloy",          price: 25  },
  { partName: "Windshield",           price: 35  }, { partName: "Door Glass",            price: 20  },
  { partName: "Mirror, Side",         price: 15  }, { partName: "Rear View Mirror",      price: 15  },
  { partName: "Headlight Assembly",   price: 20  }, { partName: "Tail Light Assembly",   price: 15  },
  { partName: "Grille",               price: 25  }, { partName: "Catalytic Converter",   price: 50  },
  { partName: "Exhaust Manifold",     price: 20  }, { partName: "Intake Manifold",       price: 25  },
  { partName: "Strut Assembly",       price: 25  }, { partName: "Control Arm",           price: 20  },
  { partName: "Brake Caliper",        price: 15  }, { partName: "Rotor",                 price: 10  },
  { partName: "ECU/Computer",         price: 35  }, { partName: "Instrument Cluster",    price: 30  },
  { partName: "Radio/Stereo",         price: 20  }, { partName: "Air Bag",               price: 50  },
  { partName: "Sunroof",              price: 35  }, { partName: "Valve Cover",           price: 20  },
  { partName: "Power Window Motor",   price: 15  }, { partName: "Running Board",         price: 25  },
];

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", redis: !!(redisUrl && redisToken), version: 7 }));

app.get("/yards", rateLimit(30), async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ error: "Missing location query" });
  const qWords = q.split(/[\s,]+/).filter(w => w.length > 1);
  const scored = KNOWN_STORES.map(s => {
    const hay = (s.name + " " + s.address).toLowerCase();
    const score = qWords.reduce((n, w) => n + (s.name.toLowerCase().includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0);
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a,b) => b.score - a.score);
  if (!scored.length) return res.json({ yards: KNOWN_STORES, message: "No exact match — showing all yards." });
  res.json({ yards: scored.slice(0, 8) });
});

// ── Inventory scraping with background job + polling ─────────────────────────
// Job states: "running" | { error: string } | absent (done — data in cache)
const scrapeJobs = new Map();

app.get("/inventory/:yardId", rateLimit(20), async (req, res) => {
  const { yardId } = req.params;
  const cacheKey = `inv:${yardId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) { log("inv", `cache hit: ${yardId}`); return res.json(cached); }

  const job = scrapeJobs.get(yardId);
  if (job === "running") return res.json({ status: "scraping" });
  if (job?.error) { scrapeJobs.delete(yardId); return res.json({ error: job.error }); }

  scrapeJobs.set(yardId, "running");
  res.json({ status: "scraping" });

  log("inv", `fetching: ${yardId}`);
  try {
    const html = await fetchPage(`https://www.pyp.com/inventory/${yardId}/`, "https://www.pyp.com/");
    const $ = cheerioLoad(html);
    const vehicles = [];

    $(".pypvi_resultRow").each((_, el) => {
      if (vehicles.length >= 50) return false; // audit fix: was 20
      const $el = $(el);
      const ymm = $el.find(".pypvi_ymm").text().replace(/\s+/g," ").trim();
      const m = ymm.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
      if (!m) return;
      const [, year, make, model] = m;
      let row=null, section=null, color=null, vin=null, stockNo=null, dateAdded=null;
      $el.find(".pypvi_detailItem").each((_, d) => {
        const t = $(d).text().replace(/\s+/g," ").trim();
        const g = re => t.match(re)?.[1]?.trim() || null;
        row     = row     || g(/Row\s*:\s*(\S+)/i);
        section = section || g(/Section\s*:\s*(\S+)/i);
        color   = color   || g(/Color\s*:\s*(.+)/i);
        vin     = vin     || g(/VIN\s*:\s*(\S+)/i);
        stockNo = stockNo || g(/Stock\s*#\s*:\s*(\S+)/i);
      });
      const te = $el.find("time");
      if (te.length) dateAdded = te.attr("datetime")?.split("T")[0] || te.text().trim();
      vehicles.push({ year: parseInt(year), make, model, section, row, color, vin, stockNo, dateAdded,
        img: $el.find("img").first().attr("src") || null });
    });

    if (!vehicles.length) {
      scrapeJobs.set(yardId, { error: `No vehicles found for "${yardId}" — the yard may be empty or the page structure changed.` });
      return;
    }

    const result = { vehicles, yardScore: scoreYard(vehicles) };
    await cacheSet(cacheKey, result, TTL.inventory);
    scrapeJobs.delete(yardId);
    log("inv", `done: ${vehicles.length} vehicles for ${yardId}`);
  } catch(e) {
    log("inv", `failed: ${yardId}: ${e.message}`);
    scrapeJobs.set(yardId, { error: "Failed to load inventory: " + e.message });
  }
});

// ── eBay scraping with background job + polling ───────────────────────────────
const ebayJobs = new Map();
let ebayBrowserBusy = false;

async function runEbayJob(cacheKey, year, make, model) {
  try {
    const queries = await getSearchQueries(year, make, model);
    log("ebay", `fetching ${queries.length} queries: ${year} ${make} ${model}`);
    const listings = await fetchEbayListings(queries);
    await matchAndScoreListings(listings, PYP_PRICES);
    log("ebay", `cached ${listings.length} for ${year} ${make} ${model}`);
    await cacheSet(cacheKey, listings, TTL.ebay);
    ebayJobs.delete(cacheKey);
  } catch(e) {
    log("ebay", `job failed for ${cacheKey}: ${e.message}`);
    ebayJobs.set(cacheKey, { error: e.message });
  } finally {
    ebayBrowserBusy = false;
  }
}

app.get("/ebay", rateLimit(15), async (req, res) => {
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing params" });

  const cacheKey = `ebay:${year}:${make}:${model}`;
  const cached = await cacheGet(cacheKey);
  if (cached) { log("ebay", `cache hit: ${year} ${make} ${model}`); return res.json({ listings: cached }); }

  const job = ebayJobs.get(cacheKey);
  if (job === "running") return res.json({ status: "scraping" });
  if (job?.error) { ebayJobs.delete(cacheKey); return res.json({ error: job.error }); }

  if (ebayBrowserBusy) return res.json({ status: "scraping" });

  ebayJobs.set(cacheKey, "running");
  ebayBrowserBusy = true;
  res.json({ status: "scraping" });
  runEbayJob(cacheKey, year, make, model);
});

app.get("/prices/:yardId", (req, res) => {
  res.json({ parts: PYP_PRICES, sourceUrl: `https://www.pyp.com/prices/${req.params.yardId}/` });
});

// Prefetch: warms eBay cache for all vehicles in a yard, respects browser lock
app.get("/prefetch/:yardId", rateLimit(5), async (req, res) => {
  const inv = await cacheGet(`inv:${req.params.yardId}`);
  if (!inv?.vehicles) return res.json({ ok: false, reason: "inventory not cached" });
  res.json({ ok: true, count: inv.vehicles.length });

  for (const v of inv.vehicles) {
    const key = `ebay:${v.year}:${v.make}:${v.model}`;
    if (await cacheGet(key)) continue;
    if (ebayJobs.get(key) === "running" || ebayBrowserBusy) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    ebayJobs.set(key, "running");
    ebayBrowserBusy = true;
    await runEbayJob(key, v.year, v.make, v.model);
    await new Promise(r => setTimeout(r, 2000));
  }
});

// ── Admin / utility routes ────────────────────────────────────────────────────
app.get("/stores", (_, res) => res.json({ stores: KNOWN_STORES }));

app.get("/cache-stats", (_, res) => res.json({ memCacheSize: memCache.size, redis: !!(redisUrl && redisToken) }));

app.get("/cache-clear", async (req, res) => {
  // Require ADMIN_TOKEN if set
  if (ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  memCache.clear();
  if (redisUrl && redisToken) {
    try {
      await axios.get(`${redisUrl}/flushall`, { headers: { Authorization: `Bearer ${redisToken}` }, timeout: 5000 });
      return res.json({ ok: true, message: "memory + Redis cache cleared" });
    } catch(e) { return res.json({ ok: true, message: "memory cleared, Redis flush failed: " + e.message }); }
  }
  res.json({ ok: true, message: "memory cache cleared" });
});

// ── Static files & error handling ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
app.use((req, res) => res.status(404).json({ error: "Not found: " + req.path }));

process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

app.listen(PORT, "0.0.0.0", () =>
  log("server", `Junkyard Pro v7 on port ${PORT} | Redis: ${!!(redisUrl && redisToken)}`));
