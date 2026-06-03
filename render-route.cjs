// CommonJS version — matches a `require()`-based Express app.
// Render env vars needed: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (read-only token).
// You can delete on Render: SCRAPERAPI_KEY, ANTHROPIC_API_KEY.

const express = require("express");
const { createClient } = require("@libsql/client");

const router = express.Router();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// GET /api/opportunities?minProfit=20
// Sorting/columns stay client-side (default profit desc), like your current UI.
router.get("/api/opportunities", async (req, res) => {
  const minProfit = parseFloat(req.query.minProfit || "0");
  try {
    const result = await db.execute({
      sql: `SELECT yard, vehicle, category, yard_price,
                   ebay_median, ebay_low, ebay_high, ebay_sold_count,
                   ebay_url, profit, margin, updated_at
            FROM profit_rows
            WHERE profit >= ?
            ORDER BY profit DESC`,
      args: [minProfit],
    });
    res.json({ rows: result.rows, count: result.rows.length });
  } catch (e) {
    console.error("DB read failed:", e.message);
    res.status(500).json({ error: "failed to load opportunities" });
  }
});

// Optional: "updated 14 min ago" freshness indicator.
router.get("/api/last-updated", async (_req, res) => {
  try {
    const r = await db.execute("SELECT MAX(updated_at) AS ts FROM profit_rows");
    res.json({ updatedAt: r.rows[0] ? r.rows[0].ts : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
EOF