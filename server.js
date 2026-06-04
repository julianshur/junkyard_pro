// v6 - Redis cache, hardcoded stores + prices, extended TTLs
import express from "express";
import axios   from "axios";
import { load as cheerioLoad } from "cheerio";
import cors    from "cors";
import path    from "path";
import fs      from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 5180;

app.use(cors({ origin: "*", methods: ["GET"] }));
app.get("/test", (_, res) => res.json({ ok: true, version: 6 }));

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
// TTLs
const TTL = {
  inventory: 4  * 60 * 60,  // 4 hours
  ebay:      72 * 60 * 60,  // 72 hours
  queries:   7  * 24 * 60 * 60, // 7 days (same car = same queries)
};

// In-memory fallback
const memCache = new Map();
function memGet(key) {
  const e = memCache.get(key);
  if (!e || Date.now() > e.exp) { memCache.delete(key); return null; }
  return e.data;
}
function memSet(key, data, ttlSec) {
  memCache.set(key, { data, exp: Date.now() + ttlSec * 1000 });
}

// Redis client (optional — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
let redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
let redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cacheGet(key) {
  // Try Redis first
  if (redisUrl && redisToken) {
    try {
      const r = await axios.get(`${redisUrl}/get/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${redisToken}` }, timeout: 3000 });
      const val = r.data?.result;
      if (val) return JSON.parse(val);
    } catch(e) { /* fall through to memory */ }
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
    } catch(e) { /* Redis unavailable, memory cache still works */ }
  }
}

// ── fetchPage (free, no third-party scraper API) ─────────────────────────────
const cookieJar = {};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

async function fetchPage(url, referer = null) {
  const domain = new URL(url).hostname;

  // pyp.com: direct fetch with browser headers
  if (domain.includes("pyp.com")) {
    const r = await http.get(url, {
      headers: { ...BROWSER_HEADERS, "Referer": referer || "https://www.pyp.com/" },
      timeout: 25000,
    });
    return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  }

  // Direct request with browser headers + cookie jar
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

  const fallback = [`${year} ${make} ${model} engine`, `${year} ${make} ${model} transmission`, `${year} ${make} ${model} door`];

  // Try up to 2 times with a short delay
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
      const text = await claudePost(
        `For a ${year} ${make} ${model} at a self-service junkyard, list the 3 most valuable parts commonly resold on eBay. Focus on high-value items: engine, transmission, popular body parts for this specific model.
Return ONLY a JSON array of 3 eBay search strings. Example: ["2003 Honda Accord engine","2003 Honda Accord transmission","2003 Honda Accord door"]`,
        "You are an auto parts expert. Respond with a JSON array only — no explanation.",
        300
      );
      if (!text) throw new Error("empty response");
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0]);
      if (!Array.isArray(arr) || !arr.length) throw new Error("invalid array");
      console.log(`[claude] queries for ${year} ${make} ${model}:`, arr);
      await cacheSet(cacheKey, arr, TTL.queries);
      return arr;
    } catch(e) {
      console.log(`[claude] query gen attempt ${attempt+1} failed:`, e.message);
    }
  }
  console.log(`[claude] using fallback queries for ${year} ${make} ${model}`);
  return fallback;
}

async function matchAndScoreListings(listings, yardParts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !listings.length) return;

  const batch = listings.slice(0, 40);
  const partNames = yardParts.map(p => p.partName);
  const titlesStr = batch.map((l, i) => `${i}: ${l.title} [$${l.soldPrice}, ${l.soldCount}x sold]`).join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      const text = await claudePost(
        `Match these eBay used auto part listings to PYP junkyard categories.\nCategories: ${partNames.join(", ")}\nListings:\n${titlesStr}\nJSON format: {"0":{"category":"Engine, 4 Cyl","demand":4},"1":{"category":"NO_MATCH","demand":0}}\ndemand: 1-5 (5=high volume). NO_MATCH if unclear.`,
        "You are an auto parts expert. Respond with valid JSON only — no explanations, no markdown.",
        2000
      );
      if (!text) throw new Error("null response");
      const start = text.indexOf("{"), end2 = text.lastIndexOf("}");
      if (start === -1 || end2 === -1) throw new Error("No JSON: " + text.slice(0, 80));
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
      console.log(`[claude] matched ${matched}/${batch.length}`);
      return;
    } catch(e) {
      console.log(`[claude] match attempt ${attempt+1} failed:`, e.message);
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

// ── eBay scraping helper ──────────────────────────────────────────────────────
async function fetchEbayListings(searchQueries) {
  const allListings = [];
  for (const q of searchQueries) {
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=6028&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=12&_ipg=60`;
    try {
      const html = await fetchPage(url, "https://www.ebay.com/");
      const $ = cheerioLoad(html);
      const newUI = $(".s-card").length > 0;
      const sel = newUI ? ".s-card" : ".s-item";
      const selCount = $(sel).length;
      console.log(`[ebay] "${q.slice(0,40)}" ui:${newUI?"s-card":"s-item"} items:${selCount} htmlLen:${typeof html === "string" ? html.length : "non-string"}`);

      $(sel).each((_, el) => {
        const $el = $(el), ct = $el.text();
        let title, price, href, condition, dateSold = null;
        if (newUI) {
          // Title is in .s-card__title .su-styled-text.primary
          title = $el.find(".s-card__title .su-styled-text.primary").text().trim() ||
                  $el.find(".s-card__title").text().trim();
          // Price: extract first $XX.XX from card text
          const priceMatch = ct.match(/\$([0-9,]+\.[0-9]{2})/);
          price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : 0;
          // Link
          href = $el.find("a.s-card__link").first().attr("href") || $el.find("a").first().attr("href") || "";
          // Condition: .s-card__subtitle .su-styled-text (secondary)
          condition = $el.find(".s-card__subtitle .su-styled-text").first().text().trim() || null;
          // Sold date from card text
          const soldDateMatch = ct.match(/Sold\s+\w+\s+\d+,\s+\d{4}/);
          dateSold = soldDateMatch ? soldDateMatch[0] : null;
        } else {
          title = ($el.find(".s-item__title span[role=heading]").text() || $el.find(".s-item__title").text()).replace("New listing","").trim();
          price = parseFloat($el.find(".s-item__price").first().text().replace(/[^0-9.]/g,""));
          href  = $el.find(".s-item__link").attr("href") || "";
          condition = $el.find(".SECONDARY_INFO,.s-item__subtitle").first().text().trim() || null;
        }
        title = (title||"").replace(/Opens in a new window or tab/gi,"").replace(/\s+/g," ").trim();
        if (!title || title === "Shop on eBay" || !price || price < 1) return;
        // Skip promo/placeholder cards
        if (!href || href.includes("rover.ebay.com")) return;
        // Only reject if condition field (not title) says "New" — avoids rejecting used items with "New" in part name
        const cond = (condition||"").toLowerCase();
        if (cond === "new" || cond === "brand new") return;
        const sm = ct.match(/(\d[\d,]*)\s+sold/i);
        allListings.push({ title, soldPrice: price, url: href ? href.split("?")[0] : null, category: condition, soldCount: sm ? parseInt(sm[1].replace(/,/g,"")) : 1, dateSold });
      });
    } catch(e) {
      console.log(`[ebay] query failed "${q}":`, e.message);
      if (e.response?.status === 429) break;
    }
  }
  const seen = new Set();
  return allListings.filter(l => { if (!l.url || seen.has(l.url)) return false; seen.add(l.url); return true; })
    .sort((a,b) => (b.soldCount - a.soldCount) || (b.soldPrice - a.soldPrice));
}

// ── Hardcoded PYP store list (all confirmed slugs) ────────────────────────────
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

// ── Hardcoded PYP price list (standard SoCal flat rates) ─────────────────────
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
app.get("/health", (_, res) => res.json({ status: "ok", redis: !!(redisUrl && redisToken) }));

app.get("/yards", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ error: "Missing location query" });

  const qWords = q.split(/[\s,]+/).filter(w => w.length > 1);
  const scored = KNOWN_STORES.map(s => {
    const hay = (s.name + " " + s.address).toLowerCase();
    const score = qWords.reduce((n, w) => n + (s.name.toLowerCase().includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0);
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a,b) => b.score - a.score);

  if (!scored.length) return res.json({ yards: KNOWN_STORES, message: `No exact match — showing all yards.` });
  res.json({ yards: scored.slice(0, 8) });
});

app.get("/debug-pyp/:yardId", async (req, res) => {
  const url = `https://www.pyp.com/inventory/${req.params.yardId}/`;
  try {
    const r = await http.get(url, { headers: BROWSER_HEADERS, timeout: 25000 });
    const html = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    res.setHeader("Content-Type", "text/plain");
    res.send(html.slice(0, 8000));
  } catch(e) { res.status(500).send(e.message); }
});

app.get("/inventory/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const cacheKey = `inv:${yardId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) { console.log(`[inv] cache hit: ${yardId}`); return res.json(cached); }

  console.log(`[inv] fetching: ${yardId}`);
  let html;
  try { html = await fetchPage(`https://www.pyp.com/inventory/${yardId}/`, "https://www.pyp.com/"); }
  catch(e) { return res.json({ error: "Failed to load inventory: " + e.message }); }

  const $ = cheerioLoad(html);
  const vehicles = [];
  $(".pypvi_resultRow").each((_, el) => {
    if (vehicles.length >= 20) return false;
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
    vehicles.push({ year: parseInt(year), make, model, section, row, color, vin, stockNo, dateAdded, img: $el.find("img").first().attr("src") || null });
  });

  if (!vehicles.length) return res.json({ error: `No vehicles found for "${yardId}"` });

  const yardScore = scoreYard(vehicles);
  const result = { vehicles, yardScore };
  await cacheSet(cacheKey, result, TTL.inventory);
  res.json(result);
});

app.get("/prices/:yardId", async (req, res) => {
  // Prices are hardcoded — no scraping needed
  res.json({ parts: PYP_PRICES, sourceUrl: `https://www.pyp.com/prices/${req.params.yardId}/` });
});

app.get("/ebay", async (req, res) => {
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing params" });

  const cacheKey = `ebay:${year}:${make}:${model}`;
  const cached = await cacheGet(cacheKey);
  if (cached) { console.log(`[ebay] cache hit: ${year} ${make} ${model}`); return res.json({ listings: cached }); }

  const queries = await getSearchQueries(year, make, model);
  console.log(`[ebay] fetching ${queries.length} queries: ${year} ${make} ${model}`);
  const listings = await fetchEbayListings(queries);
  await matchAndScoreListings(listings, PYP_PRICES);
  const withPrices = listings.filter(l => l.pypPrice != null).length;
  console.log(`[ebay] withPypPrice: ${withPrices}/${listings.length}`);
  await cacheSet(cacheKey, listings, TTL.ebay);
  console.log(`[ebay] cached ${listings.length} for ${year} ${make} ${model}`);
  res.json({ listings });
});

app.get("/prefetch/:yardId", async (req, res) => {
  const inv = await cacheGet(`inv:${req.params.yardId}`);
  if (!inv?.vehicles) return res.json({ ok: false, reason: "inventory not cached" });
  res.json({ ok: true, count: inv.vehicles.length });

  // Background: warm eBay cache one vehicle at a time with delays
  for (let i = 0; i < inv.vehicles.length; i++) {
    const v = inv.vehicles[i];
    const key = `ebay:${v.year}:${v.make}:${v.model}`;
    if (await cacheGet(key)) continue;
    try {
      const queries = await getSearchQueries(v.year, v.make, v.model);
      const listings = await fetchEbayListings(queries);
      await matchAndScoreListings(listings, PYP_PRICES);
      await cacheSet(key, listings, TTL.ebay);
      console.log(`[prefetch] ${v.year} ${v.make} ${v.model}: ${listings.length} listings`);
    } catch(e) { console.log(`[prefetch] failed ${v.year} ${v.make} ${v.model}:`, e.message); }
    await new Promise(r => setTimeout(r, 4000)); // 4s between vehicles
  }
});

// Debug routes
app.get("/stores",      (_, res) => res.json({ stores: KNOWN_STORES }));
app.get("/cache-stats", (_, res) => res.json({ memCacheSize: memCache.size, redis: !!(redisUrl && redisToken) }));
app.get("/cache-clear", async (_, res) => {
  memCache.clear();
  // Flush Redis if connected
  if (redisUrl && redisToken) {
    try {
      await axios.get(`${redisUrl}/flushall`, { headers: { Authorization: `Bearer ${redisToken}` }, timeout: 5000 });
      res.json({ ok: true, message: "memory + Redis cache cleared" });
    } catch(e) { res.json({ ok: true, message: "memory cleared, Redis flush failed: " + e.message }); }
  } else {
    res.json({ ok: true, message: "memory cache cleared" });
  }
});

// Static files
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
app.use((req, res) => res.status(404).json({ error: "Not found: " + req.path }));

process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

app.listen(PORT, "0.0.0.0", () => console.log(`\n🔧 Junkyard Profit Finder v6 on port ${PORT} | Redis: ${!!(redisUrl && redisToken)}\n`));