import {
  ensureSchema,
  replaceRows,
  getFreshComps,
  putComps,
} from "./db.js";
import { scrapePypInventory, FLAT_RATES, CORE_DEPOSITS } from "./pyp.js";
import { classifyTitles } from "./match.js";
import {
  launchBrowser,
  scrapeEbaySold,
  soldSearchUrl,
  priceStats,
} from "./ebay.js";

// eBay fee + shipping haircut on the sold price before profit.
// 0 = raw (median - yardPrice). Set FEE_RATE=0.15 for a realistic net.
const FEE_RATE = parseFloat(process.env.FEE_RATE || "0");
const round2 = (n) => Math.round(n * 100) / 100;

// eBay search key for a vehicle. Lowercased so the comp cache dedupes across
// yards that share the same year/make/model.
const queryFor = (v) => `${v.year} ${v.make} ${v.model}`.toLowerCase();

async function run() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] run start`);

  await ensureSchema();
  const browser = await launchBrowser();

  try {
    // 1. Recent inventory cars across all yards.
    console.log("  scraping PYP inventory...");
    const vehicles = await scrapePypInventory(browser);
    console.log(`  vehicles: ${vehicles.length}`);
    if (!vehicles.length) {
      console.log("  no inventory — leaving previous data in place, exiting.");
      return;
    }

    // 2. eBay comps per UNIQUE vehicle query (cache first, TTL-gated).
    const uniqueQueries = [...new Set(vehicles.map(queryFor))];
    console.log(`  unique vehicle queries: ${uniqueQueries.length}`);

    const compsByQuery = new Map();
    let fetched = 0;
    for (const q of uniqueQueries) {
      let listings = await getFreshComps(q);
      if (!listings) {
        listings = await scrapeEbaySold(browser, q);
        await putComps(q, listings);
        fetched++;
        if (fetched % 10 === 0) console.log(`    fetched ${fetched} fresh`);
      }
      compsByQuery.set(q, listings);
    }
    console.log(`  comps: ${fetched} fetched, ${uniqueQueries.length - fetched} from cache`);

    // 3. Classify every distinct title -> bucket (title cache + Haiku).
    const allTitles = [];
    for (const listings of compsByQuery.values())
      for (const l of listings) allTitles.push(l.title);
    console.log(`  titles to classify: ${[...new Set(allTitles)].length} unique`);
    const bucketByTitle = await classifyTitles(allTitles);

    // 4. Per (vehicle, bucket): collect prices -> median -> profit.
    const now = new Date().toISOString();
    const rows = [];
    for (const v of vehicles) {
      const q = queryFor(v);
      const listings = compsByQuery.get(q) || [];

      // group this vehicle's listings by bucket
      const pricesByBucket = new Map();
      for (const l of listings) {
        const bucket = bucketByTitle.get(l.title);
        if (!bucket) continue; // unclassifiable / not a priced part
        if (!pricesByBucket.has(bucket)) pricesByBucket.set(bucket, []);
        pricesByBucket.get(bucket).push(l.price);
      }

      for (const [bucket, prices] of pricesByBucket) {
        const stats = priceStats(prices);
        if (!stats) continue;
        const yardPrice = round2(
          FLAT_RATES[bucket] + (CORE_DEPOSITS[bucket] || 0)
        );
        const profit = round2(stats.median * (1 - FEE_RATE) - yardPrice);
        rows.push({
          yard: v.yard,
          yardSlug: v.yardSlug,
          vehicle: v.vehicle,
          category: bucket,
          yardPrice,
          ebayMedian: stats.median,
          ebayLow: stats.low,
          ebayHigh: stats.high,
          ebaySoldCount: stats.count,
          ebayUrl: soldSearchUrl(`${q} ${bucket}`),
          profit,
          margin: yardPrice ? round2(profit / yardPrice) : null,
          updatedAt: now,
        });
      }
    }

    // 5. Atomic swap into Turso.
    await replaceRows(rows);
    console.log(
      `  wrote ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error("run failed:", e);
  process.exit(1);
});
