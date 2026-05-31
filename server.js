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

// ── Server-side cache (1hr TTL) ──────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

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

  // For ebay.com — use ScraperAPI if available, otherwise direct
  if (domain.includes("ebay.com") && scraperKey) {
    // render=true executes JavaScript so LH_Sold=1 filter is actually applied
    const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(url)}&render=true&country_code=us`;
    console.log(`[fetch] using ScraperAPI (rendered) for ebay`);
    const r = await http.get(proxyUrl, { timeout: 60000 });
    return r.data;
  }

  // For all other domains — direct request with cookie jar
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

// ── Claude: match listings to PYP categories + score demand ─────────────────
async function matchAndScoreListings(listings, yardParts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const partNames = yardParts.map(p => p.partName);
  // Send top 40 listings to Claude (enough for good coverage, stays within token limit)
  const batch = listings.slice(0, 40);
  const titlesStr = batch.map((l, i) => `${i}: ${l.title} [sold:${l.soldCount}x @ $${l.soldPrice}]`).join("\n");

  const prompt = `You are a junkyard parts expert. Match eBay sold listings to PYP part categories and score demand.

PYP categories: ${partNames.join(", ")}

eBay sold listings (index: title [soldCount x price]):
${titlesStr}

For each index return:
- "category": best PYP category name, or "NO_MATCH" 
- "demand": 1-5 score (5=sells fast/high volume, 1=slow/niche). Base on soldCount and price consistency.

Return ONLY JSON: {"0":{"category":"Engine, 4 Cyl","demand":4}, "1":{"category":"NO_MATCH","demand":0}, ...}
Be strict on category — a headlight washer nozzle is NOT a Headlight Assembly.`;

  try {
    const r = await http.post("https://api.anthropic.com/v1/messages", {
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 });

    const text = r.data.content[0].text;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    const results = JSON.parse(json);

    let matched = 0;
    batch.forEach((l, i) => {
      const r = results[String(i)];
      if (r && r.category && r.category !== "NO_MATCH") {
        const part = yardParts.find(p => p.partName === r.category);
        l.pypCategory = r.category;
        l.pypPrice    = part?.price || null;
        l.demand      = r.demand || 1;
        matched++;
      }
    });
    console.log(`[claude] matched ${matched}/${batch.length} listings with demand scores`);
  } catch(e) {
    console.log("[claude] match+score failed:", e.message);
  }
}

// ── Known PYP store list ──────────────────────────────────────────────────────
const KNOWN_STORES = [
  { id: "sun-valley-1263",               priceSlug: "sun-valley-1263",               name: "Pick Your Part - Sun Valley",      address: "Sun Valley, CA" },
  { id: "wilmington-help-yourself-1262", priceSlug: "wilmington-help-yourself-1262", name: "Pick Your Part - Wilmington",      address: "Wilmington, CA" },
  { id: "victorville-1287",              priceSlug: "victorville-1287",              name: "Pick Your Part - Victorville",     address: "Victorville, CA" },
  { id: "santa-fe-springs-1282",         priceSlug: "santa-fe-springs-1282",         name: "Pick Your Part - Santa Fe Springs",address: "Santa Fe Springs, CA" },
  { id: "san-bernardino-1291",           priceSlug: "san-bernardino-1291",           name: "Pick Your Part - San Bernardino",  address: "San Bernardino, CA" },
  { id: "riverside-1290",                priceSlug: "riverside-1290",                name: "Pick Your Part - Riverside",       address: "Riverside, CA" },
  { id: "ontario-1280",                  priceSlug: "ontario-1280",                  name: "Pick Your Part - Ontario",         address: "Ontario, CA" },
  { id: "monrovia-1281",                 priceSlug: "monrovia-1281",                 name: "Pick Your Part - Monrovia",        address: "Monrovia, CA" },
  { id: "hesperia-1292",                 priceSlug: "hesperia-1292",                 name: "Pick Your Part - Hesperia",        address: "Hesperia, CA" },
  { id: "fontana-1285",                  priceSlug: "fontana-1285",                  name: "Pick Your Part - Fontana",         address: "Fontana, CA" },
  { id: "chula-vista-1264",              priceSlug: "chula-vista-1264",              name: "Pick Your Part - Chula Vista",     address: "Chula Vista, CA" },
  { id: "rialto-1284",                   priceSlug: "rialto-1284",                   name: "Pick Your Part - Rialto",          address: "Rialto, CA" },
  { id: "anaheim-1265",                  priceSlug: "anaheim-1265",                  name: "Pick Your Part - Anaheim",         address: "Anaheim, CA" },
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
  const cacheKey = `inv:${yardId}`;
  const cached = cacheGet(cacheKey);
  if (cached) { console.log(`[inventory] cache hit: ${yardId}`); return res.json(cached); }

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

  const result = { vehicles };
  cacheSet(cacheKey, result);
  res.json(result);
});

// ── GET /api/prices/:yardId ───────────────────────────────────────────────────
app.get("/prices/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const { year, make, model } = req.query;

  // PYP uses yard-wide flat rate prices — standard price list for all CA yards
  // Source: https://www.pyp.com/prices/<yard>/
  // These are the standard PYP Southern California prices (updated periodically)
  const PYP_PRICES = [
    { partName: "Engine, 4 Cyl",           price: 275, keywords: ["engine"],                          exclude: [] },
    { partName: "Engine, 6 Cyl",           price: 325, keywords: ["engine"],                          exclude: [] },
    { partName: "Engine, 8 Cyl",           price: 375, keywords: ["engine"],                          exclude: [] },
    { partName: "Transmission, Auto",      price: 175, keywords: ["transmission"],                    exclude: [] },
    { partName: "Transmission, Manual",    price: 150, keywords: ["transmission"],                    exclude: [] },
    { partName: "Transfer Case",           price: 125, keywords: ["transfer", "case"],                exclude: [] },
    { partName: "Rear Axle Assembly",      price: 125, keywords: ["axle"],                            exclude: [] },
    { partName: "Front Axle Assembly",     price: 125, keywords: ["axle"],                            exclude: [] },
    { partName: "Differential",            price: 75,  keywords: ["differential"],                    exclude: [] },
    { partName: "Drive Shaft",             price: 35,  keywords: ["shaft"],                           exclude: [] },
    { partName: "Hood",                    price: 50,  keywords: ["hood"],                            exclude: ["hoodline","hoodlatch"] },
    { partName: "Door",                    price: 50,  keywords: ["door"],                            exclude: ["mirror","handle","hinge","lock","panel","glass","seal"] },
    { partName: "Trunk Lid",               price: 45,  keywords: ["trunk"],                           exclude: [] },
    { partName: "Fender",                  price: 40,  keywords: ["fender"],                          exclude: ["fender liner","splash"] },
    { partName: "Bumper",                  price: 35,  keywords: ["bumper"],                          exclude: ["bracket","reinforce","absorb","cover trim"] },
    { partName: "Radiator Core Support",   price: 45,  keywords: ["radiator","support"],              exclude: [] },
    { partName: "Radiator",                price: 35,  keywords: ["radiator"],                        exclude: ["support","core support","hose","cap"] },
    { partName: "A/C Condenser",           price: 35,  keywords: ["condenser"],                       exclude: [] },
    { partName: "AC Compressor",           price: 45,  keywords: ["compressor"],                      exclude: [] },
    { partName: "Alternator",              price: 35,  keywords: ["alternator"],                      exclude: [] },
    { partName: "Starter",                 price: 25,  keywords: ["starter"],                         exclude: [] },
    { partName: "Power Steering Pump",     price: 25,  keywords: ["steering","pump"],                 exclude: [] },
    { partName: "Water Pump",              price: 20,  keywords: ["water","pump"],                    exclude: [] },
    { partName: "Fuel Pump",               price: 25,  keywords: ["fuel","pump"],                     exclude: [] },
    { partName: "Fuel Tank",               price: 35,  keywords: ["fuel","tank"],                     exclude: [] },
    { partName: "Seat, Front",             price: 35,  keywords: ["seat"],                            exclude: ["rear","track","cover","heater"] },
    { partName: "Seat, Rear",              price: 25,  keywords: ["seat","rear"],                     exclude: [] },
    { partName: "Dashboard",               price: 50,  keywords: ["dashboard"],                       exclude: [] },
    { partName: "Steering Column",         price: 35,  keywords: ["steering","column"],               exclude: [] },
    { partName: "Tailgate",                price: 55,  keywords: ["tailgate"],                        exclude: [] },
    { partName: "Truck Bed",               price: 150, keywords: ["bed"],                             exclude: [] },
    { partName: "Steering Wheel",           price: 20,  keywords: ["steering","wheel"],               exclude: [] },
    { partName: "Wheel, Alloy",            price: 25,  keywords: ["wheel"],                           exclude: ["bearing","hub","well","steering"] },
    { partName: "Tire",                    price: 10,  keywords: ["tire"],                            exclude: [] },
    { partName: "Windshield",              price: 35,  keywords: ["windshield"],                      exclude: [] },
    { partName: "Door Glass",              price: 20,  keywords: ["window","glass"],                  exclude: [] },
    { partName: "Mirror, Side",            price: 15,  keywords: ["mirror"],                          exclude: ["rear view","rearview"] },
    { partName: "Headlight Assembly",      price: 20,  keywords: ["headlight"],                       exclude: ["washer","nozzle","bracket","cover","trim","bezel","bulb"] },
    { partName: "Tail Light Assembly",     price: 15,  keywords: ["tail light","taillight"],          exclude: [] },
    { partName: "Grille",                  price: 25,  keywords: ["grille"],                          exclude: [] },
    { partName: "Catalytic Converter",     price: 50,  keywords: ["catalytic"],                       exclude: [] },
    { partName: "Exhaust Manifold",        price: 20,  keywords: ["exhaust","manifold"],              exclude: [] },
    { partName: "Intake Manifold",         price: 25,  keywords: ["intake","manifold"],               exclude: [] },
    { partName: "Strut Assembly",          price: 25,  keywords: ["strut"],                           exclude: [] },
    { partName: "Control Arm",             price: 20,  keywords: ["control","arm"],                   exclude: [] },
    { partName: "Brake Caliper",           price: 15,  keywords: ["caliper"],                         exclude: [] },
    { partName: "Rotor",                   price: 10,  keywords: ["rotor"],                           exclude: [] },
    { partName: "ECU/Computer",            price: 35,  keywords: ["ecm","ecu","pcm","computer"],      exclude: [] },
    { partName: "Instrument Cluster",      price: 30,  keywords: ["instrument","cluster"],            exclude: [] },
    { partName: "Radio/Stereo",            price: 20,  keywords: ["radio","stereo"],                  exclude: [] },
    { partName: "Air Bag",                 price: 50,  keywords: ["airbag"],                          exclude: [] },
    { partName: "Sunroof",                 price: 35,  keywords: ["sunroof","moonroof"],              exclude: [] },
    { partName: "Running Board",           price: 25,  keywords: ["running","board"],                 exclude: [] },
    { partName: "Valve Cover",             price: 20,  keywords: ["valve","cover"],                   exclude: [] },
    { partName: "Power Window Motor",      price: 15,  keywords: ["window","motor"],                  exclude: [] },
    { partName: "Rear View Mirror",        price: 15,  keywords: ["rear","view","mirror"],            exclude: [] },
  ];

  const sourceUrl = `https://www.pyp.com/prices/${yardId}/`;
  console.log(`[prices] returning standard PYP price list for ${yardId}`);
  res.json({ parts: PYP_PRICES, sourceUrl, note: "Standard PYP flat-rate prices" });
});

// ── Ask Claude for best search queries for this specific vehicle ─────────────
async function getSearchQueries(year, make, model) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [`${year} ${make} ${model} parts`];
  try {
    const r = await http.post("https://api.anthropic.com/v1/messages", {
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content:
        `For a ${year} ${make} ${model} at a self-service junkyard, list the 5 most valuable parts commonly resold on eBay. Consider what makes this specific vehicle desirable for parts (reliable engine, popular body panels, rare trim, etc).
Return ONLY a JSON array of 5 eBay search strings like: ["2003 Honda Accord engine","2003 Honda Accord transmission"]
No explanation, just the JSON array.` }],
    }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 15000 });
    const arr = JSON.parse(r.data.content[0].text.match(/\[[\s\S]*\]/)?.[0]);
    console.log(`[claude] smart queries:`, arr);
    return arr;
  } catch(e) {
    console.log("[claude] query gen failed:", e.message);
    return [`${year} ${make} ${model} parts`];
  }
}

// ── GET /ebay ─────────────────────────────────────────────────────────────────
app.get("/ebay", async (req, res) => {
  const { year, make, model } = req.query;
  if (!year || !make || !model) return res.json({ error: "Missing params" });

  // Check cache first
  const ebayKey = `ebay:${year}:${make}:${model}`;
  const cached = cacheGet(ebayKey);
  if (cached) { console.log(`[ebay] cache hit: ${year} ${make} ${model}`); return res.json({ listings: cached }); }

  // Claude generates targeted queries for this vehicle
  const searchQueries = await getSearchQueries(year, make, model);
  console.log(`[ebay] searching ${searchQueries.length} queries for ${year} ${make} ${model}`);

  // Fetch all queries in parallel
  const allListings = [];
  await Promise.all(searchQueries.map(async (q) => {
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=6028&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=12&_ipg=60`;
    try {
      const html = await fetchPage(url, "https://www.ebay.com/");
      const $ = cheerio.load(html);
      const useNewUI = $(".s-card").length > 0;
      const selector = useNewUI ? ".s-card" : ".s-item";

      $(selector).each((_, el) => {
        const $el = $(el);
        let title, price, href, dateSold, condition;
        const cardText = $el.text();

        if (useNewUI) {
          title = $el.find("h3").first().text().trim() || $el.find(".s-card__title,[class*=card-title]").text().trim();
          const priceTexts = [];
          $el.find("[class*=price],[class*=Price]").each((_, p) => {
            const t = $(p).text().trim();
            if (t && t.match(/\$[0-9]/)) priceTexts.push(t);
          });
          price = parseFloat((priceTexts[0] || $el.find("[class*=price]").first().text()).replace(/[^0-9.]/g,"")) || 0;
          href  = $el.find("a").first().attr("href") || "";
          dateSold  = $el.find("[class*=sold],[class*=POSITIVE],[class*=signal],[class*=ended]").first().text().trim() || cardText.match(/Sold [A-Z][a-z]+/)?.[0] || null;
          condition = $el.find("[class*=SECONDARY],[class*=subtitle],[class*=condition]").first().text().trim() || null;
        } else {
          title     = ($el.find(".s-item__title span[role=heading]").text() || $el.find(".s-item__title").text()).replace("New listing","").trim();
          price     = parseFloat($el.find(".s-item__price").first().text().replace(/[^0-9.]/g,""));
          href      = $el.find(".s-item__link").attr("href") || "";
          dateSold  = $el.find(".s-item__caption--signal,.s-item__ended-date,.POSITIVE").first().text().trim() || null;
          condition = $el.find(".SECONDARY_INFO,.s-item__subtitle").first().text().trim() || null;
        }

        title = (title||"").replace(/Opens in a new window or tab/gi,"").replace(/\s+/g," ").trim();
        if (!title || title === "Shop on eBay" || title === "Results matching fewer words") return;
        if (!price || price < 1) return;
        const cond = (condition||"").toLowerCase();
        if (cond.includes("new") && !cond.includes("like new") && !cond.includes("open box")) return;
        const soldMatch = cardText.match(/(\d[\d,]*)\s+sold/i);
        const soldCount = soldMatch ? parseInt(soldMatch[1].replace(/,/g,"")) : 1;
        allListings.push({ title, soldPrice: price, url: href ? href.split("?")[0] : null, dateSold, category: condition, soldCount });
      });
    } catch(e) {
      console.log(`[ebay] query failed "${q}":`, e.message);
    }
  }));

  // Dedupe by URL, sort by soldCount desc then price desc
  const seenUrls = new Set();
  const listings = allListings.filter(l => {
    if (!l.url || seenUrls.has(l.url)) return false;
    seenUrls.add(l.url); return true;
  }).sort((a,b) => (b.soldCount - a.soldCount) || (b.soldPrice - a.soldPrice));

  console.log(`[ebay] ${listings.length} unique listings from ${searchQueries.length} queries`);

  // Claude matches each listing to a PYP category AND scores demand 1-5
  const PYP_PARTS = [
    { partName: "Engine, 4 Cyl", price: 275 }, { partName: "Engine, 6 Cyl", price: 325 },
    { partName: "Engine, 8 Cyl", price: 375 }, { partName: "Transmission, Auto", price: 175 },
    { partName: "Transmission, Manual", price: 150 }, { partName: "Transfer Case", price: 125 },
    { partName: "Rear Axle Assembly", price: 125 }, { partName: "Differential", price: 75 },
    { partName: "Drive Shaft", price: 35 }, { partName: "Hood", price: 50 },
    { partName: "Door", price: 50 }, { partName: "Trunk Lid", price: 45 },
    { partName: "Fender", price: 40 }, { partName: "Bumper", price: 35 },
    { partName: "Radiator Core Support", price: 45 }, { partName: "Radiator", price: 35 },
    { partName: "A/C Condenser", price: 35 }, { partName: "AC Compressor", price: 45 },
    { partName: "Alternator", price: 35 }, { partName: "Starter", price: 25 },
    { partName: "Power Steering Pump", price: 25 }, { partName: "Water Pump", price: 20 },
    { partName: "Fuel Pump", price: 25 }, { partName: "Fuel Tank", price: 35 },
    { partName: "Seat, Front", price: 35 }, { partName: "Seat, Rear", price: 25 },
    { partName: "Dashboard", price: 50 }, { partName: "Steering Column", price: 35 },
    { partName: "Steering Wheel", price: 20 }, { partName: "Tailgate", price: 55 },
    { partName: "Truck Bed", price: 150 }, { partName: "Wheel, Alloy", price: 25 },
    { partName: "Windshield", price: 35 }, { partName: "Door Glass", price: 20 },
    { partName: "Mirror, Side", price: 15 }, { partName: "Headlight Assembly", price: 20 },
    { partName: "Tail Light Assembly", price: 15 }, { partName: "Grille", price: 25 },
    { partName: "Catalytic Converter", price: 50 }, { partName: "Exhaust Manifold", price: 20 },
    { partName: "Intake Manifold", price: 25 }, { partName: "Strut Assembly", price: 25 },
    { partName: "Control Arm", price: 20 }, { partName: "Brake Caliper", price: 15 },
    { partName: "ECU/Computer", price: 35 }, { partName: "Instrument Cluster", price: 30 },
    { partName: "Radio/Stereo", price: 20 }, { partName: "Air Bag", price: 50 },
    { partName: "Sunroof", price: 35 }, { partName: "Valve Cover", price: 20 },
  ];

  await matchAndScoreListings(listings, PYP_PARTS);

  // Cache for 1hr so repeated clicks are instant
  const ebayKey2 = `ebay:${year}:${make}:${model}`;
  cacheSet(ebayKey2, listings);

  res.json({ listings });
});


// ── GET /prefetch/:yardId — pre-warm eBay cache for all vehicles ──────────────
app.get("/prefetch/:yardId", async (req, res) => {
  const { yardId } = req.params;
  const invCached = cacheGet(`inv:${yardId}`);
  if (!invCached?.vehicles) return res.json({ ok: false, reason: "no inventory cached" });

  res.json({ ok: true, count: invCached.vehicles.length }); // respond immediately

  // Background: warm eBay cache for each vehicle, 3 at a time
  const vehicles = invCached.vehicles;
  for (let i = 0; i < vehicles.length; i += 3) {
    await Promise.all(vehicles.slice(i, i + 3).map(async v => {
      const key = `ebay:${v.year}:${v.make}:${v.model}`;
      if (cacheGet(key)) return;
      try {
        // Simulate the eBay fetch by calling our own route internally
        const queries = await getSearchQueries(v.year, v.make, v.model);
        const allL = [];
        await Promise.all(queries.map(async q => {
          const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=6028&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4&_sop=12&_ipg=60`;
          try {
            const html = await fetchPage(url, "https://www.ebay.com/");
            const $ = cheerio.load(html);
            const newUI = $(".s-card").length > 0;
            const sel = newUI ? ".s-card" : ".s-item";
            $(sel).each((_, el) => {
              const $el=$(el), ct=$el.text();
              let title="", price=0, href="", condition="";
              if (newUI) {
                title=$el.find("h3").first().text().trim();
                const pt=[]; $el.find("[class*=price]").each((_,p)=>{const t=$(p).text().trim();if(t.match(/\$[0-9]/))pt.push(t);});
                price=parseFloat((pt[0]||"").replace(/[^0-9.]/g,""))||0;
                href=$el.find("a").first().attr("href")||"";
                condition=$el.find("[class*=SECONDARY],[class*=condition]").first().text().trim()||"";
              } else {
                title=$el.find(".s-item__title").text().replace("New listing","").trim();
                price=parseFloat($el.find(".s-item__price").first().text().replace(/[^0-9.]/g,""));
                href=$el.find(".s-item__link").attr("href")||"";
                condition=$el.find(".SECONDARY_INFO").first().text().trim()||"";
              }
              title=(title||"").replace(/Opens in a new window or tab/gi,"").replace(/\s+/g," ").trim();
              if (!title||title==="Shop on eBay"||!price||price<1) return;
              const c=condition.toLowerCase();
              if (c.includes("new")&&!c.includes("like new")&&!c.includes("open box")) return;
              const sm=ct.match(/(\d[\d,]*)\s+sold/i);
              allL.push({title,soldPrice:price,url:href?href.split("?")[0]:null,category:condition,soldCount:sm?parseInt(sm[1].replace(/,/g,"")):1});
            });
          } catch(e){}
        }));
        const seen=new Set();
        const listings=allL.filter(l=>{if(!l.url||seen.has(l.url))return false;seen.add(l.url);return true;})
          .sort((a,b)=>(b.soldCount-a.soldCount)||(b.soldPrice-a.soldPrice));
        const PYP=[
          {partName:"Engine, 4 Cyl",price:275},{partName:"Engine, 6 Cyl",price:325},{partName:"Engine, 8 Cyl",price:375},
          {partName:"Transmission, Auto",price:175},{partName:"Transmission, Manual",price:150},{partName:"Transfer Case",price:125},
          {partName:"Rear Axle Assembly",price:125},{partName:"Differential",price:75},{partName:"Drive Shaft",price:35},
          {partName:"Hood",price:50},{partName:"Door",price:50},{partName:"Trunk Lid",price:45},{partName:"Fender",price:40},
          {partName:"Bumper",price:35},{partName:"Radiator Core Support",price:45},{partName:"Radiator",price:35},
          {partName:"A/C Condenser",price:35},{partName:"AC Compressor",price:45},{partName:"Alternator",price:35},
          {partName:"Starter",price:25},{partName:"Power Steering Pump",price:25},{partName:"Water Pump",price:20},
          {partName:"Fuel Pump",price:25},{partName:"Fuel Tank",price:35},{partName:"Seat, Front",price:35},
          {partName:"Seat, Rear",price:25},{partName:"Dashboard",price:50},{partName:"Steering Column",price:35},
          {partName:"Steering Wheel",price:20},{partName:"Tailgate",price:55},{partName:"Wheel, Alloy",price:25},
          {partName:"Windshield",price:35},{partName:"Headlight Assembly",price:20},{partName:"Tail Light Assembly",price:15},
          {partName:"Grille",price:25},{partName:"Catalytic Converter",price:50},{partName:"ECU/Computer",price:35},
          {partName:"Instrument Cluster",price:30},{partName:"Radio/Stereo",price:20},{partName:"Air Bag",price:50},
        ];
        await matchAndScoreListings(listings, PYP);
        cacheSet(key, listings);
        console.log(`[prefetch] ${v.year} ${v.make} ${v.model}: ${listings.length} listings cached`);
      } catch(e){ console.log(`[prefetch] failed ${v.year} ${v.make} ${v.model}:`, e.message); }
    }));
  }
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