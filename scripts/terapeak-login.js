// One-time interactive login. Opens a real (visible) browser window so you can
// log into your own eBay seller account by hand — including any 2FA/captcha
// step automation can't do for you. The session is saved to terapeak-profile/
// (gitignored) and reused headlessly by terapeak-explore.js / the app itself.
//
// Run with: node scripts/terapeak-login.js
import { chromium } from "playwright";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, "..", "terapeak-profile");

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1280, height: 900 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.ebay.com/sh/research", { waitUntil: "domcontentloaded" });

console.log("\nLog into your eBay seller account in the opened window.");
console.log("Once you can see the Seller Hub Research page with search results, come back here and press Enter.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question("Press Enter when logged in: ", resolve));
rl.close();

await ctx.close();
console.log("Session saved.");
