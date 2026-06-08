import axios from "axios";
import { load as cheerioLoad } from "cheerio";

const QUERY = "2010 VW Passat Headlight Used";
const URL   = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(QUERY)}&LH_Sold=1&LH_Complete=1&_sop=12&_ipg=25`;

console.log("Fetching:", URL, "\n");

const r = await axios.get(URL, {
  timeout: 20000,
  responseType: "text",
  transformResponse: [d => d],
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  },
});

const html = r.data;
console.log(`HTTP ${r.status} — HTML length: ${html.length} bytes`);
console.log(`Has 'Error Page': ${html.includes("Error Page")}`);
console.log(`Has 'g-recaptcha': ${html.includes("g-recaptcha")}\n`);

const $ = cheerioLoad(html);
const items = $(".s-item");
console.log(`.s-item elements found: ${items.length}\n`);

const listings = [];
items.each((_, el) => {
  const $el  = $(el);
  const title = $el.find(".s-item__title").first().text().trim();
  const price = $el.find(".s-item__price").first().text().trim();
  const href  = $el.find("a.s-item__link").attr("href") || "";
  if (!title || /shop on ebay/i.test(title)) return;
  listings.push({ title, price, href: href.slice(0, 80) });
});

if (!listings.length) {
  console.log("NO LISTINGS PARSED — dumping first 1000 chars of HTML:\n");
  console.log(html.slice(0, 1000));
} else {
  console.log(`Parsed ${listings.length} listings:\n`);
  listings.forEach((l, i) => {
    console.log(`${i + 1}. ${l.title}`);
    console.log(`   Price: ${l.price}`);
    console.log(`   URL:   ${l.href}`);
    console.log();
  });
}
