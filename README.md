# Junkyard Profit Finder — local scraper + Turso handoff

The scrape moved off Render to your Windows machine (residential IP, your RAM).
Render now just reads a Turso DB. No ScraperAPI, no 401/403, no SIGTERM.

## 1. Turso (one-time)

Easiest cross-platform path is the Turso dashboard:
1. Create a database (free tier is plenty for hundreds–low thousands of rows).
2. Copy its **URL** (looks like `libsql://your-db.turso.io`).
3. Create **two tokens**: a read+write token (local job) and a read-only token (Render).

(If you'd rather use the CLI, it runs cleanly under WSL/Mac/Linux:
`turso db create junkyardpro`, `turso db show --url`, `turso db tokens create`.)

## 2. Local scraper (Windows)

```
cd C:\junkyard\scraper
npm install
npx playwright install chromium
```

Set env vars (PowerShell, persists for your user):
```
setx TURSO_DATABASE_URL "libsql://your-db.turso.io"
setx TURSO_AUTH_TOKEN   "your-READWRITE-token"
setx ANTHROPIC_API_KEY  "sk-ant-..."
setx FEE_RATE           "0.15"   REM optional; 0 = median - yardPrice
```
(Open a NEW terminal after `setx` so they load.)

Paste your existing PYP logic into `pyp.js` (the file marks exactly where:
`YARDS`, `FLAT_RATES`, and the `scrapeYard()` body). Then test once:
```
npm run scrape
```
First run will be slowest (Haiku categorizes every part); later runs reuse the
cache, so they mostly just hit eBay.

## 3. Schedule it hourly

Edit the path in `run-scraper.bat`, then register the task (one line, admin shell):
```
schtasks /create /tn "JunkyardScrape" /tr "C:\junkyard\run-scraper.bat" /sc hourly /st 00:05
```
Check `scrape.log` after the first scheduled run. To run on demand:
`schtasks /run /tn "JunkyardScrape"`.

## 4. Render

- Add `@libsql/client` to the Render app's dependencies.
- Mount `render-route.js` (adapt to your app structure).
- Render env: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (**read-only** token).
- Delete from Render: `SCRAPERAPI_KEY`, `ANTHROPIC_API_KEY`, and the old
  scraping code / Puppeteer dep.

## The one thing to verify before trusting numbers

eBay's price selector. Open a sold-search URL in your browser, F12, and confirm
the per-card price element. If `[class*="price"]` isn't grabbing the right node,
tweak the selector in `ebay.js` (`scrapeEbaySold` → `page.evaluate`). The median
math downstream is only as good as that extraction.