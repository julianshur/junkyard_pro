const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 5180;

app.use(cors({ origin: "*", methods: ["GET"] }));

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

  // Prime cookies by visiting homepage if we haven't yet
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
    if (!cookieJar[domain]) cookieJar[domain] = ""; // mark as attempted
  }

  const headers = {};
  if (cookieJar[domain]) headers["Cookie"] = cookieJar[domain];
  if (referer) headers["Referer"] = referer;

  const r = await http.get(url, { headers, maxRedirects: 5 });

  // Update cookies from response
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

  const url = `https://www.pyp.com/parts/${yardId}/?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`;
  console.log(`[prices] fetching: ${url}`);

  let html;
  try {
    html = await fetchPage(url, `https://www.pyp.com/inventory/${yardId}/`);
  } catch (err) {
    return res.json({ error: "Failed to load prices: " + err.message });
  }

  const $ = cheerio.load(html);
  const parts = [];

  $("table tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;
    const partName = cells.eq(0).text().trim();
    const price    = parseFloat(cells.eq(1).text().replace(/[^0-9.]/g, ""));
    if (partName && price) parts.push({ partName, price });
  });

  console.log(`[prices] found ${parts.length} parts`);
  res.json({ parts, sourceUrl: url });
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