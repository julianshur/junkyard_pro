// Discovery run: loads the saved login session, searches Seller Hub Research
// for a sample query, and dumps a screenshot + HTML so we can see what the
// real markup looks like before writing a real scraper against it.
//
// Run with: node scripts/terapeak-explore.js "2012 honda accord alternator"
import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, "..", "terapeak-profile");
const OUT_DIR = path.join(__dirname, "terapeak-out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const query = process.argv[2] || "2012 honda accord alternator";

if (!fs.existsSync(PROFILE_DIR)) {
  console.error("No saved session found. Run `node scripts/terapeak-login.js` first and log in.");
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, channel: "chrome" });
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto("https://www.ebay.com/sh/research", { waitUntil: "domcontentloaded", timeout: 30000 });

// If the session expired, Seller Hub bounces to a signin page.
if (/signin/i.test(page.url())) {
  console.error("Not logged in (redirected to signin). Re-run terapeak-login.js.");
  await ctx.close();
  process.exit(1);
}

const searchBox = await page
  .waitForSelector('input[type="text"], input[type="search"]', { timeout: 15000 })
  .catch(() => null);

if (!searchBox) {
  console.error("Couldn't find a search input on the page — layout may differ from expected.");
} else {
  await searchBox.fill(query);
  await searchBox.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

await page.waitForTimeout(3000);

await page.screenshot({ path: path.join(OUT_DIR, "research.png"), fullPage: true });
fs.writeFileSync(path.join(OUT_DIR, "research.html"), await page.content());

console.log(`Saved screenshot + HTML to ${OUT_DIR}`);
console.log(`Current URL: ${page.url()}`);

await ctx.close();
