// v5 - no puppeteer, routes at root
const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 5180;

app.use(cors({ origin: "*", methods: ["GET"] }));

// Test route
app.get("/test", (_, res) => res.json({ ok: true, routes: "working", version: 5 }));

// Shared axios instance that mimics a real browser
const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "sec-ch-ua": '"Chromium";v="124","Google Chrome";v="124"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "Upgrade-Insecure-Requests": "1",
  },
});

// Fetch a page, first hitting the homepage to get session cookies
const cookieJar = {}; // domain -> cookie string

async function fetchPage(url, referer = null) {
  const domain = new URL(url).hostname;

  // For pyp.com — route through ScraperAPI (free tier: 1000 req/month)
  // Sign up free at https://www.scraperapi.com/ and set SCRAPER_API_KEY env var
  // Without a key we try direct first, then fall back to allorigins proxy
  const scraperKey = process.env.SCRAPER_API_KEY;

  if (domain.includes("pyp.com") && scraperKey) {
    const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(url)}&render=false`;
    console.log(`[fetch] using ScraperAPI for ${url}`);
    const r = await http.get(proxyUrl, { timeout: 30000 });
    return r.data;
  }

  // For pyp.com without a key — try multiple free proxies in order
  if (domain.includes("pyp.com")) {
    const proxies = [
      // ScraperSite raw proxy
      `https://thingproxy.freeboard.io/fetch/${url}`,
      // corsproxy.io
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      // allorigins
      `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    ];

    for (const proxyUrl of proxies) {
      try {
        console.log(`[fetch] trying proxy: ${proxyUrl.split('?')[0]}`);
        const r = await http.get(proxyUrl, { timeout: 20000 });
        const html = r.data?.contents || r.data;
        if (typeof html === 'string' && html.includes('pypvi_resultRow')) {
          console.log(`[fetch] proxy worked: ${proxyUrl.split('?')[0]}`);
          return html;
        }
        if (typeof html === 'string' && html.length > 1000) {
          console.log(`[fetch] proxy returned HTML (no rows): ${proxyUrl.split('?')[0]}`);
          return html; // return anyway, let parser handle it
        }
      } catch(e) {
        console.log(`[fetch] proxy failed: ${e.message}`);
      }
    }
    throw new Error('All proxies failed for ' + url);
  }

  // For all other domains (eBay etc) — direct request with cookie jar
  if (!cookieJar[domain]) {
    try {
      const homeUrl = `https://${domain}/`;
      const r = await http.get(homeUrl, { maxRedirects: 5 });
      const setCookie = r.headers["set-cookie"];
      if (setCookie) {
        cookieJar[domain] = setCookie.map(c => c.split(";")[0]).join("; ");
        console.log(`[cookies] primed for ${domain}`);
      }
    } catch(_) {}
    if (!cookieJar[domain]) cookieJar[domain] = "";
  }

  const headers = {};
  if (cookieJar[domain]) headers["Cookie"] = cookieJar[domain];
  if (referer) headers["Referer"] = referer;

  const r = await http.get(url, { headers, maxRedirects: 5 });

  const setCookie = r.headers["set-cookie"];
  if (setCookie) {
    const newCookies = setCookie.map(c => c.split(";")[0]).join("; ");
    cookieJar[domain] = cookieJar[domain]
      ? cookieJar[domain] + "; " + newCookies
      : newCookies;
  }

  return r.data;
}

// ── Known PYP store list ──────────────────────────────────────────────────────
const KNOWN_STORES = [
  { id: "sun-valley-1263",                   priceSlug: "sun-valley-help-yourself-1263",     name: "Pick Your Part - Sun Valley",      address: "8000 Laurel Canyon Blvd, Sun Valley, CA" },
  { id: "wilmington-help-yourself-1262",     priceSlug: "wilmington-help-yourself-1262",     name: "Pick Your Part - Wilmington",      address: "1600 E Anaheim St, Wilmington, CA" },
  { id: "el-monte-help-yourself-1269",       priceSlug: "el-monte-help-yourself-1269",       name: "Pick Your Part - El Monte",        address: "3888 Tyler Ave, El Monte, CA" },
  { id: "stanton-help-yourself-1267",        priceSlug: "stanton-help-yourself-1267",        name: "Pick Your Part - Stanton",         address: "10901 Beach Blvd, Stanton, CA" },
  { id: "fresno-help-yourself",              priceSlug: "fresno-help-yourself",              name: "Pick Your Part - Fresno",          address: "4620 S Chestnut Ave, Fresno, CA" },
  { id: "san-bernardino-help-yourself-1274", priceSlug: "san-bernardino-help-yourself-1274", name: "Pick Your Part - San Bernardino",  address: "2205 W 2nd St, San Bernardino, CA" },
  { id: "long-beach-help-yourself-1259",     priceSlug: "long-beach-help-yourself-1259",     name: "Pick Your Part - Long Beach",      address: "2700 E Willow St, Long Beach, CA" },
  { id: "van-nuys-help-yourself",            priceSlug: "van-nuys-help-yourself",            name: "Pick Your Part - Van Nuys",        address: "7901 Sepulveda Blvd, Van Nuys, CA" },
  { id: "north-hollywood-help-yourself",     priceSlug: "north-hollywood-help-yourself",     name: "Pick Your Part - North Hollywood", address: "7600 Lankershim Blvd, North Hollywood, CA" },
  { id: "orlando-help-yourself",             priceSlug: "orlando-help-yourself",             name: "Pick Your Part - Orlando",         address: "5900 Hoffner Ave, Orlando, FL" },
  { id: "houston-help-yourself",             priceSlug: "houston-help-yourself",             name: "Pick Your Part - Houston",         address: "9435 Wallisville Rd, Houston, TX" },
  { id: "phoenix-help-yourself",             priceSlug: "phoenix-help-yourself",             name: "Pick Your Part - Phoenix",         address: "4020 W Lower Buckeye Rd, Phoenix, AZ" },
  { id: "las-vegas-help-yourself",           priceSlug: "las-vegas-help-yourself",           name: "Pick Your Part - Las Vegas",       address: "6750 W Cheyenne Ave, Las Vegas, NV" },
  { id: "sacramento-help-yourself",          priceSlug: "sacramento-help-yourself",          name: "Pick Your Part - Sacramento",      address: "Sacramento, CA" },
  { id: "denver-help-yourself",              priceSlug: "denver-help-yourself",              name: "Pick Your Part - Denver",          address: "Denver, CO" },
  { id: "portland-help-yourself",            priceSlug: "portland-help-yourself",            name: "Pick Your Part - Portland",        address: "Portland, OR" },
  { id: "seattle-help-yourself",             priceSlug: "seattle-help-yourself",             name: "Pick Your Part - Seattle",         address: "Seattle, WA" },
];

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── GET /api/yards?q=<location> ───────────────────────────────────────────────
app.get("/yards", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ error: "Missing location query" });
  console.log(`[yards] searching: "${q}"`);

  let allStores = [...KNOWN_STORES];

  // Try to scrape live store list
  try {
    const html = await fetchPage("https://www.pyp.com/locations");
    const $ = cheerio.load(html);
    $("a[href*='/inventory/']").each((_, el) => {
      const slug = $(el).attr("href")?.match(/\/inventory\/([^/]+)/)?.[1];
      const name = $(el).text().trim();
      if (slug && name && !allStores.find(s => s.id === slug)) {
        allStores.push({ id: slug, name, address: "" });
      }
    });
    console.log(`[yards] total after scrape: ${allStores.length}`);
  } catch (err) {
    console.log(`[yards] scrape failed: ${err.message}`);
  }

  const qWords = q.split(/[\s,]+/).filter(w => w.length > 1);
  const scored = allStores.map(s => {
    const nameH = s.name.toLowerCase();
    const addrH = s.address.toLowerCase();
    const score = qWords.reduce((n, w) => n + (nameH.includes(w) ? 2 : addrH.includes(w) ? 1 : 0), 0);
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return res.json({ yards: allStores.slice(0, 12), message: `No exact match — showing all known yards.` });
  }
  res.json({ yards: scored.slice(0, 6) });
});

// ── GET /api/inventory/:yardId ────────────────────────────────────────────────
app.get("/inventory/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const url = `https://www.pyp.com/inventory/${yardId}/`;
  console.log(`[inventory] fetching: ${url}`);

  let html;
  try {
    html = await fetchPage(url, "https://www.pyp.com/");
  } catch (err) {
    return res.json({ error: "Failed to load inventory: " + err.message });
  }

  const $ = cheerio.load(html);
  const vehicles = [];

  $(".pypvi_resultRow").each((_, el) => {
    if (vehicles.length >= 20) return false;
    const $el = $(el);
    const ymmText  = $el.find(".pypvi_ymm").text().replace(/\s+/g, " ").trim();
    const ymmMatch = ymmText.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
    if (!ymmMatch) return;
    const [, year, make, model] = ymmMatch;

    let row = null, section = null, color = null, vin = null, stockNo = null, dateAdded = null;
    $el.find(".pypvi_detailItem").each((_, d) => {
      const text = $(d).text().replace(/\s+/g, " ").trim();
      const m = re => text.match(re)?.[1]?.trim() || null;
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

  const rowCount = (html.match(/pypvi_resultRow/g) || []).length;
  console.log(`[inventory] pypvi_resultRow in HTML: ${rowCount}, parsed: ${vehicles.length}`);

  if (!vehicles.length) {
    return res.json({ error: `No vehicles found for "${yardId}". rowCount=${rowCount}` });
  }
  res.json({ vehicles });
});

// ── GET /api/prices/:yardId ───────────────────────────────────────────────────
app.get("/prices/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing year/make/model" });

  // Look up the known price slug, or generate candidates
  const knownStore = KNOWN_STORES.find(s => s.id === yardId);
  const storeNum = yardId.match(/(\d+)$/)?.[1] || "";
  const pricesSlugs = knownStore?.priceSlug
    ? [knownStore.priceSlug, yardId, yardId.replace(/-(\d+)$/, `-help-yourself-$1`)]
    : [yardId.replace(/-(\d+)$/, `-help-yourself-$1`), yardId];

  const url = `https://www.pyp.com/prices/${pricesSlugs[0]}/`;
  console.log(`[prices] fetching: ${url}`);

  let html = null;
  let workingUrl = url;

  for (const slug of pricesSlugs) {
    const tryUrl = `https://www.pyp.com/prices/${slug}/`;
    try {
      console.log(`[prices] trying: ${tryUrl}`);
      const h = await fetchPage(tryUrl, `https://www.pyp.com/`);
      if (typeof h === "string" && h.length > 5000) {
        html = h;
        workingUrl = tryUrl;
        console.log(`[prices] success: ${tryUrl}`);
        break;
      }
    } catch(e) {
      console.log(`[prices] failed ${tryUrl}: ${e.message}`);
    }
  }

  if (!html) return res.json({ error: "Could not load prices page. Try visiting pyp.com/prices directly.", sourceUrl: url });

  const $ = cheerio.load(html);
  const parts = [];

  // Try multiple selectors for PYP price table
  // Log snippet to find the right structure
  const bodyIdx = html.indexOf('<body');
  const snippet = html.slice(bodyIdx > 0 ? bodyIdx : 0, (bodyIdx > 0 ? bodyIdx : 0) + 2000);
  console.log('[prices] HTML snippet:', snippet.replace(/\s+/g, ' ').slice(0, 800));

  // Try table rows
  $("table tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;
    const partName = cells.eq(0).text().trim();
    const price    = parseFloat(cells.eq(1).text().replace(/[^0-9.]/g, ""));
    if (partName && price) parts.push({ partName, price });
  });

  // Try list items with prices
  if (!parts.length) {
    $("li, .price-item, [class*='part'], [class*='price-row'], dl dt, .pyppp_partName").each((_, el) => {
      const $el = $(el);
      const name = $el.text().trim();
      // Look for sibling or next element with price
      const priceEl = $el.next();
      const price = parseFloat(priceEl.text().replace(/[^0-9.]/g, ""));
      if (name && price && price > 0 && price < 5000) parts.push({ partName: name, price });
    });
  }

  // Try any element containing dollar amounts
  if (!parts.length) {
    $("[class*='price'], [class*='part']").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const m = text.match(/^(.{3,50}?)\s+\$\s*([0-9]+(?:\.[0-9]{2})?)/);
      if (m) parts.push({ partName: m[1].trim(), price: parseFloat(m[2]) });
    });
  }

  // Filter out motorcycle parts (MC prefix), scrap, and generic items
  const filtered = parts.filter(p => {
    const n = p.partName.toUpperCase();
    return !n.startsWith("MC ") &&
           !n.includes("SCRAP") &&
           !n.includes("FREON") &&
           !n.includes("BATTERY") &&
           p.price > 0 &&
           p.price < 10000;
  });
  console.log(`[prices] found ${parts.length} parts, filtered to ${filtered.length}, html length: ${html.length}`);
  console.log("[prices] snippet:", typeof html === "string" ? html.slice(0, 600).replace(/\s+/g, " ") : "non-string response");
  res.json({ parts: filtered, sourceUrl: workingUrl, debug: { htmlLength: html.length, snippet: typeof html === "string" ? html.slice(0, 300) : "non-string" } });
});

// ── GET /api/ebay ─────────────────────────────────────────────────────────────
app.get("/ebay", async (req, res) => {
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing params" });

  const query = encodeURIComponent(`${year} ${make} ${model} parts`);
  const url   = `https://www.ebay.com/sch/i.html?_nkw=${query}&_sacat=6028&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=16&_ipg=60`;
  console.log(`[ebay] fetching: ${url}`);

  let html;
  try {
    html = await fetchPage(url, "https://www.ebay.com/");
  } catch (err) {
    return res.json({ error: "Failed to load eBay: " + err.message });
  }

  const $ = cheerio.load(html);
  const listings = [];

  const useNewUI = $(".s-card").length > 0;
  const selector = useNewUI ? ".s-card" : ".s-item";
  console.log(`[ebay] UI: ${useNewUI ? "new(s-card)" : "old(s-item)"}, count: ${$(selector).length}`);

  $(selector).each((_, el) => {
    if (listings.length >= 20) return false;
    const $el = $(el);
    let title, price, href, dateSold, condition;

    if (useNewUI) {
      title     = $el.find(".s-card__title, [class*='card__title']").text().trim() || $el.find("h3,h2").first().text().trim();
      price     = parseFloat($el.find("[class*='price']").first().text().replace(/[^0-9.]/g, ""));
      href      = $el.find("a.s-card__link, a[class*='card__link'], a").first().attr("href") || "";
      dateSold  = $el.find("[class*='sold'],[class*='ended'],[class*='date']").first().text().trim() || null;
      condition = $el.find("[class*='condition'],[class*='subtitle']").first().text().trim() || null;
    } else {
      title     = ($el.find(".s-item__title span[role='heading']").text() || $el.find(".s-item__title").text()).replace("New listing","").trim();
      price     = parseFloat($el.find(".s-item__price").first().text().replace(/[^0-9.]/g,""));
      href      = $el.find(".s-item__link").attr("href") || "";
      dateSold  = $el.find(".s-item__caption--signal,.s-item__ended-date,.POSITIVE").first().text().trim() || null;
      condition = $el.find(".SECONDARY_INFO,.s-item__subtitle").first().text().trim() || null;
    }

    if (!title || title === "Shop on eBay" || !price || price < 5) return;
    listings.push({ title, soldPrice: price, url: href ? href.split("?")[0] : null, dateSold, category: condition });
  });

  listings.sort((a, b) => b.soldPrice - a.soldPrice);
  console.log(`[ebay] returning ${listings.length} listings`);
  res.json({ listings });
});

// Serve static files AFTER API routes so /yards etc. aren't intercepted
const publicDir = path.join(__dirname, "public");
if (require("fs").existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Global error handler — always return JSON
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

// 404 handler — return JSON not HTML
app.use((req, res) => {
  res.status(404).json({ error: 'Not found: ' + req.path });
});

// ── Shutdown ──────────────────────────────────────────────────────────────────
process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔧 Junkyard Profit Finder running on port ${PORT}\n`);
});