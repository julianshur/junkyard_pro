import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// LH_Sold=1 + LH_Complete=1 -> sold/completed. LH_ItemCondition=3000 -> Used.
// _ipg=240 grabs a full results page so we never page or open item pages.
export function soldSearchUrl(query) {
  const q = encodeURIComponent(query);
  return `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3000&_ipg=240`;
}

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One page load, summary cards only. Returns [{ title, price }].
export async function scrapeEbaySold(browser, query) {
  const url = soldSearchUrl(query);
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .waitForSelector(".s-card, li.s-item", { timeout: 15000 })
      .catch(() => {});

    const listings = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(".s-card, li.s-item")
      );
      const out = [];
      for (const card of cards) {
        const titleEl = card.querySelector('[class*="title" i]');
        const title = (titleEl ? titleEl.textContent : "").trim();
        if (!title || /^shop on ebay$/i.test(title)) continue;

        const priceEl = card.querySelector('[class*="price" i]');
        const ptext = (priceEl ? priceEl.textContent : "") || "";
        const m = ptext.match(/\$\s?([\d,]+(?:\.\d{2})?)/); // first $; ranges -> low
        if (!m) continue;
        const price = parseFloat(m[1].replace(/,/g, ""));
        if (!isFinite(price) || price <= 0) continue;

        out.push({ title, price });
      }
      return out;
    });

    return listings;
  } catch (e) {
    console.error(`  eBay scrape failed for "${query}": ${e.message}`);
    return [];
  } finally {
    await ctx.close();
    await sleep(1500 + Math.random() * 2000); // polite to a single residential IP
  }
}

// Median + trimmed range for a set of prices (one part bucket of one vehicle).
export function priceStats(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
  const core = sorted.slice(trim, sorted.length - trim);
  const mid = Math.floor(core.length / 2);
  const median =
    core.length % 2 ? core[mid] : (core[mid - 1] + core[mid]) / 2;
  return {
    median: round2(median),
    low: round2(core[0]),
    high: round2(core[core.length - 1]),
    count: prices.length,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
