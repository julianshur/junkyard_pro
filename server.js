const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 5180;

app.use(cors({
  origin: '*', // Allow all origins — lock this down to your Turbify domain in production
  methods: ['GET'],
}));
app.use(express.static(path.join(__dirname, "public")));

// ── Puppeteer browser singleton ───────────────────────────────────────────────
// One browser instance is reused across requests to avoid slow cold starts.
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  const puppeteer = require("puppeteer");
  const fs2 = require("fs");

  // On cloud (Railway/Render) use puppeteer's bundled Chromium.
  // On Windows dev machine, prefer system Chrome.
  const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.DYNO);

  let executablePath;
  if (!isCloud) {
    const chromePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    executablePath = chromePaths.find(p => { try { return fs2.existsSync(p); } catch(_) { return false; } });
  }

  if (executablePath) console.log("[browser] using system Chrome:", executablePath);
  else console.log("[browser] using Puppeteer bundled Chromium");

  browser = await puppeteer.launch({
    headless: "new",
    executablePath: executablePath || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  console.log("[browser] launched");
  return browser;
}

// Fetch a URL with a real headless Chrome, return the final HTML.
async function fetchWithBrowser(url, waitFor = null) {
  const b    = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for specific element or settle for 2s
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
      // Extra buffer for all rows to render
      await new Promise(r => setTimeout(r, 500));
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }

    return await page.content();
  } finally {
    await page.close();
  }
}

// ── Known PYP store list ──────────────────────────────────────────────────────
const KNOWN_STORES = [
  { id: "sun-valley-1263",     name: "Pick Your Part - Sun Valley",      address: "8000 Laurel Canyon Blvd, Sun Valley, CA" },
  { id: "wilmington-1258",     name: "Pick Your Part - Wilmington",      address: "1600 E Anaheim St, Wilmington, CA" },
  { id: "el-monte-1269",       name: "Pick Your Part - El Monte",        address: "3888 Tyler Ave, El Monte, CA" },
  { id: "stanton-1267",        name: "Pick Your Part - Stanton",         address: "10901 Beach Blvd, Stanton, CA" },
  { id: "fresno",              name: "Pick Your Part - Fresno",          address: "4620 S Chestnut Ave, Fresno, CA" },
  { id: "san-bernardino-1274", name: "Pick Your Part - San Bernardino",  address: "2205 W 2nd St, San Bernardino, CA" },
  { id: "long-beach-1259",     name: "Pick Your Part - Long Beach",      address: "2700 E Willow St, Long Beach, CA" },
  { id: "van-nuys",            name: "Pick Your Part - Van Nuys",        address: "7901 Sepulveda Blvd, Van Nuys, CA" },
  { id: "north-hollywood",     name: "Pick Your Part - North Hollywood", address: "7600 Lankershim Blvd, North Hollywood, CA" },
  { id: "orlando",             name: "Pick Your Part - Orlando",         address: "5900 Hoffner Ave, Orlando, FL" },
  { id: "houston",             name: "Pick Your Part - Houston",         address: "9435 Wallisville Rd, Houston, TX" },
  { id: "phoenix",             name: "Pick Your Part - Phoenix",         address: "4020 W Lower Buckeye Rd, Phoenix, AZ" },
  { id: "las-vegas",           name: "Pick Your Part - Las Vegas",       address: "6750 W Cheyenne Ave, Las Vegas, NV" },
  { id: "sacramento",          name: "Pick Your Part - Sacramento",      address: "Sacramento, CA" },
  { id: "denver",              name: "Pick Your Part - Denver",          address: "Denver, CO" },
  { id: "portland",            name: "Pick Your Part - Portland",        address: "Portland, OR" },
  { id: "seattle",             name: "Pick Your Part - Seattle",         address: "Seattle, WA" },
];

// ── GET /api/yards?q=<location> ───────────────────────────────────────────────
app.get("/api/yards", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ error: "Missing location query" });
  console.log(`[yards] searching for: "${q}"`);

  // Try to scrape pyp.com/locations with Puppeteer for a fresh store list
  let allStores = [...KNOWN_STORES];
  try {
    const html = await fetchWithBrowser("https://www.pyp.com/locations");
    const $ = cheerio.load(html);
    $("a[href*='/inventory/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const slug = href.match(/\/inventory\/([^/]+)/)?.[1];
      if (!slug) return;
      const name = $(el).text().trim();
      const address = $(el).closest("[class*='store'],[class*='location']")
        .find("[class*='address'],address,p").first().text().trim();
      if (slug && name && !allStores.find(s => s.id === slug)) {
        allStores.push({ id: slug, name, address });
      }
    });
    console.log(`[yards] total stores after scrape: ${allStores.length}`);
  } catch (err) {
    console.log(`[yards] locations scrape failed: ${err.message} — using known list`);
  }

  // Fuzzy match — score by word overlap but weight name/city matches higher
  const qWords = q.split(/[\s,]+/).filter(Boolean).filter(w => w.length > 1);
  const scored = allStores.map(s => {
    const nameHay = s.name.toLowerCase();
    const addrHay = s.address.toLowerCase();
    const fullHay = nameHay + ' ' + addrHay;
    // Each query word: 2pts if in name, 1pt if in address
    const score = qWords.reduce((n, w) => {
      if (nameHay.includes(w)) return n + 2;
      if (addrHay.includes(w)) return n + 1;
      return n;
    }, 0);
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return res.json({
      yards: allStores.slice(0, 12),
      message: `No exact match for "${q}" — showing all known yards.`,
    });
  }

  // If top result score is tied, show all tied results so user can pick
  const topScore = scored[0].score;
  const topMatches = scored.filter(s => s.score === topScore);
  res.json({ yards: topMatches.length === 1 ? topMatches : scored.slice(0, 6) });
});

// ── GET /api/inventory/:yardId ────────────────────────────────────────────────
app.get("/api/inventory/:yardId", async (req, res) => {
  const { yardId } = req.params;
  if (!yardId) return res.json({ error: "Missing yard ID" });

  const url = `https://www.pyp.com/inventory/${yardId}/`;
  console.log(`[inventory] fetching: ${url}`);

  let html;
  try {
    // Use Puppeteer — pyp.com blocks plain axios with 403 (Cloudflare)
    html = await fetchWithBrowser(url, ".pypvi_resultRow");
  } catch (err) {
    console.error("[inventory] browser fetch failed:", err.message);
    return res.json({ error: "Failed to load inventory page: " + err.message });
  }

  const $        = cheerio.load(html);
  const vehicles = [];

  $(".pypvi_resultRow").each((_, el) => {
    if (vehicles.length >= 20) return false;
    const $el = $(el);

    const ymmText = $el.find(".pypvi_ymm").text().replace(/\s+/g, " ").trim();
    const ymmMatch = ymmText.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
    if (!ymmMatch) return;
    const [, year, make, model] = ymmMatch;

    let row = null, section = null, color = null, vin = null, stockNo = null, dateAdded = null;

    $el.find(".pypvi_detailItem").each((_, d) => {
      const text = $(d).text().replace(/\s+/g, " ").trim();
      const m = (re) => text.match(re)?.[1]?.trim() || null;
      row     = row     || m(/Row\s*:\s*(\S+)/i);
      section = section || m(/Section\s*:\s*(\S+)/i);
      color   = color   || m(/Color\s*:\s*(.+)/i);
      vin     = vin     || m(/VIN\s*:\s*(\S+)/i);
      stockNo = stockNo || m(/Stock\s*#\s*:\s*(\S+)/i);
    });

    const timeEl = $el.find("time");
    if (timeEl.length) dateAdded = timeEl.attr("datetime")?.split("T")[0] || timeEl.text().trim();

    const img = $el.find("img").first().attr("src") || null;

    vehicles.push({ year: parseInt(year), make, model, section, row, color, vin, stockNo, dateAdded, img });
  });

  console.log(`[inventory] found ${vehicles.length} vehicles`);

  if (!vehicles.length) {
    // Log what we actually got to help debug
    const rowCount = (html.match(/pypvi_resultRow/g) || []).length;
    const ymmCount = (html.match(/pypvi_ymm/g) || []).length;
    console.log(`[inventory] debug — pypvi_resultRow: ${rowCount}, pypvi_ymm: ${ymmCount}, html length: ${html.length}`);
    if (rowCount === 0) {
      const bodyIdx = html.indexOf('<body');
      console.log('[inventory] body snippet:', html.slice(bodyIdx, bodyIdx + 400));
    }
    return res.json({ error: `No vehicles found for "${yardId}". rowCount=${rowCount} ymmCount=${ymmCount}` });
  }

  res.json({ vehicles });
});

// ── GET /api/ebay?year=&make=&model= ─────────────────────────────────────────
app.get("/api/ebay", async (req, res) => {
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing year/make/model" });

  const query = encodeURIComponent(`${year} ${make} ${model} parts`);
  const url   = `https://www.ebay.com/sch/i.html?_nkw=${query}&_sacat=6028&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=16&_ipg=60`;
  console.log(`[ebay] fetching: ${url}`);

  let html;
  try {
    // Visit eBay homepage first to pick up cookies, then go to search
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    // Land on eBay first for cookies
    await page.goto("https://www.ebay.com", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
    await new Promise(r => setTimeout(r, 1500));
    // Now navigate to the sold search
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".s-item__title", { timeout: 10000 }).catch(() => {});
    html = await page.content();
    await page.close();
  } catch (err) {
    console.log("[ebay] browser error:", err.message);
    return res.json({ error: "Failed to load eBay: " + err.message });
  }

  const $        = cheerio.load(html);
  const listings = [];

  // eBay now uses .s-card (new UI) — fall back to .s-item (old UI) if needed
  const useNewUI = $(".s-card").length > 0;
  const selector = useNewUI ? ".s-card" : ".s-item";
  console.log(`[ebay] UI: ${useNewUI ? 'new (s-card)' : 'old (s-item)'}, count: ${$(selector).length}`);

  $(selector).each((_, el) => {
    if (listings.length >= 20) return false;
    const $el = $(el);

    let title, price, href, dateSold, condition;

    if (useNewUI) {
      // New eBay card UI (2024+)
      title = $el.find(".s-card__title, [class*='card__title'], .su-card__title").text().trim();
      if (!title) title = $el.find("h3, h2").first().text().trim();
      const priceEl = $el.find("[class*='price']").first();
      price = parseFloat(priceEl.text().replace(/[^0-9.]/g, ""));
      href  = $el.find("a.s-card__link, a[class*='card__link'], a").first().attr("href") || "";
      dateSold  = $el.find("[class*='sold'], [class*='ended'], [class*='date']").first().text().trim() || null;
      condition = $el.find("[class*='condition'], [class*='subtitle']").first().text().trim() || null;
    } else {
      // Legacy .s-item UI
      title = (
        $el.find(".s-item__title span[role='heading']").text() ||
        $el.find(".s-item__title").text()
      ).replace("New listing", "").trim();
      price    = parseFloat($el.find(".s-item__price").first().text().replace(/[^0-9.]/g, ""));
      href     = $el.find(".s-item__link").attr("href") || "";
      dateSold = $el.find(".s-item__caption--signal, .s-item__ended-date, .POSITIVE, .s-item__caption span").first().text().trim() || null;
      condition = $el.find(".SECONDARY_INFO, .s-item__subtitle").first().text().trim() || null;
    }

    if (!title || title === "Shop on eBay" || title === "Results matching fewer words") return;
    if (!price || price < 5) return;

    listings.push({
      title,
      soldPrice: price,
      url:      href ? href.split("?")[0] : null,
      dateSold,
      category: condition,
    });
  });

  listings.sort((a, b) => b.soldPrice - a.soldPrice);
  console.log(`[ebay] returning ${listings.length} listings`);
  res.json({ listings });
});



// ── GET /api/prices/:yardId?year=&make=&model= ───────────────────────────────
// Scrapes PYP part prices for a specific vehicle.
app.get("/api/prices/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing year/make/model" });

  const url = `https://www.pyp.com/parts/${yardId}/?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`;
  console.log(`[prices] fetching: ${url}`);

  let html;
  try {
    html = await fetchWithBrowser(url, ".parts-table, table, .price-row, [class*='price']");
  } catch (err) {
    return res.json({ error: "Failed to load prices: " + err.message });
  }

  const $ = cheerio.load(html);
  const parts = [];

  // PYP prices page renders a table of parts with prices
  // Try multiple selectors for their table structure
  const rows = $("table tr, .price-row, [class*='partRow'], [class*='part-row']");
  console.log(`[prices] found ${rows.length} rows`);

  rows.each((_, el) => {
    const $el = $(el);
    const cells = $el.find("td");
    if (cells.length < 2) return;
    const partName = cells.eq(0).text().trim();
    const priceText = cells.eq(1).text().trim();
    const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));
    if (!partName || !price) return;
    parts.push({ partName, price });
  });

  // Fallback: look for any element with a dollar amount near a part name
  if (!parts.length) {
    $("[class*='part'], [class*='price-item'], li").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const m = text.match(/^(.+?)\s+\$([0-9]+(?:\.[0-9]{2})?)/);
      if (m) parts.push({ partName: m[1].trim(), price: parseFloat(m[2]) });
    });
  }

  if (!parts.length) {
    // Log snippet for debugging
    console.log("[prices] no parts found, snippet:", html.slice(html.indexOf("<body"), html.indexOf("<body") + 600));
  }

  console.log(`[prices] found ${parts.length} parts`);
  res.json({ parts, sourceUrl: url });
});

// ── GET /api/debug/:yardId — dump raw HTML for inspection ────────────────────
app.get("/api/debug/:yardId", async (req, res) => {
  const { yardId } = req.params;
  try {
    const html = await fetchWithBrowser(`https://www.pyp.com/inventory/${yardId}/`, null);
    const snippet = html.slice(0, 3000);
    const hasRows = html.includes('pypvi_resultRow');
    const rowCount = (html.match(/pypvi_resultRow/g) || []).length;
    res.json({ yardId, hasRows, rowCount, snippet });
  } catch(err) {
    res.json({ error: err.message });
  }
});

// Health check — Railway uses this to confirm the app is alive
app.get("/health", (_, res) => res.json({ status: "ok" }));

// Health check — Railway uses this to confirm the app is alive
app.get("/health", (_, res) => res.json({ status: "ok" }));

// Exit immediately on shutdown signals
process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Bind to 0.0.0.0 so Railway can reach the port
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
🔧 Junkyard Profit Finder running on port ${PORT}
`);
});