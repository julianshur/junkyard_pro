import { createClient } from "@libsql/client";

// Local job needs a read+write token. Render gets a read-only token (see README).
export const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COMP_TTL_HOURS = parseFloat(process.env.COMP_TTL_HOURS || "24");

export async function ensureSchema() {
  await db.batch(
    [
      // The served table: one row per (yard, vehicle, part bucket).
      `CREATE TABLE IF NOT EXISTS profit_rows (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        yard            TEXT NOT NULL,
        yard_slug       TEXT,
        vehicle         TEXT NOT NULL,
        category        TEXT NOT NULL,
        yard_price      REAL NOT NULL,
        ebay_median     REAL,
        ebay_low        REAL,
        ebay_high       REAL,
        ebay_sold_count INTEGER,
        ebay_url        TEXT,
        profit          REAL,
        margin          REAL,
        updated_at      TEXT NOT NULL
      )`,
      // Raw eBay comps cached per vehicle query, with a timestamp for TTL.
      `CREATE TABLE IF NOT EXISTS ebay_comps (
        query       TEXT PRIMARY KEY,
        listings    TEXT NOT NULL,   -- JSON: [{title, price}]
        scraped_at  TEXT NOT NULL
      )`,
      // title -> FLAT_RATES bucket. bucket = "" means "no bucket fits" (cached
      // so we never re-ask Haiku about the same junk title).
      `CREATE TABLE IF NOT EXISTS title_buckets (
        title       TEXT PRIMARY KEY,
        bucket      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )`,
    ],
    "write"
  );
}

// ── eBay comp cache ──────────────────────────────────────────────────────────
// Returns cached listings if scraped within the TTL, else null (caller scrapes).
export async function getFreshComps(query) {
  const r = await db.execute({
    sql: "SELECT listings, scraped_at FROM ebay_comps WHERE query = ?",
    args: [query],
  });
  if (!r.rows[0]) return null;
  const ageHrs = (Date.now() - Date.parse(r.rows[0].scraped_at)) / 3.6e6;
  if (ageHrs > COMP_TTL_HOURS) return null;
  try {
    return JSON.parse(r.rows[0].listings);
  } catch {
    return null;
  }
}

export async function putComps(query, listings) {
  await db.execute({
    sql: `INSERT INTO ebay_comps (query, listings, scraped_at) VALUES (?,?,?)
          ON CONFLICT(query) DO UPDATE SET listings=excluded.listings, scraped_at=excluded.scraped_at`,
    args: [query, JSON.stringify(listings), new Date().toISOString()],
  });
}

// ── title -> bucket cache ─────────────────────────────────────────────────────
export async function getCachedBuckets(titles) {
  // Batched lookup; returns Map(title -> bucket|null). Missing titles absent.
  const map = new Map();
  if (!titles.length) return map;
  // Chunk to keep the SQL parameter list reasonable.
  for (let i = 0; i < titles.length; i += 200) {
    const chunk = titles.slice(i, i + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT title, bucket FROM title_buckets WHERE title IN (${placeholders})`,
      args: chunk,
    });
    for (const row of r.rows) map.set(row.title, row.bucket || null);
  }
  return map;
}

export async function putBucket(title, bucket) {
  await db.execute({
    sql: `INSERT INTO title_buckets (title, bucket, created_at) VALUES (?,?,?)
          ON CONFLICT(title) DO UPDATE SET bucket=excluded.bucket`,
    args: [title, bucket || "", new Date().toISOString()],
  });
}

// ── profit rows (atomic swap) ─────────────────────────────────────────────────
export async function replaceRows(rows) {
  const tx = await db.transaction("write");
  try {
    await tx.execute("DELETE FROM profit_rows");
    for (const r of rows) {
      await tx.execute({
        sql: `INSERT INTO profit_rows
          (yard, yard_slug, vehicle, category, yard_price,
           ebay_median, ebay_low, ebay_high, ebay_sold_count, ebay_url,
           profit, margin, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          r.yard, r.yardSlug, r.vehicle, r.category, r.yardPrice,
          r.ebayMedian, r.ebayLow, r.ebayHigh, r.ebaySoldCount, r.ebayUrl,
          r.profit, r.margin, r.updatedAt,
        ],
      });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
