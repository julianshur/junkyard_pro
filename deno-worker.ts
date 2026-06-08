// Deno Deploy — eBay sold listings proxy
// Deploy at: dash.deno.com → New Playground → paste this → Save & Deploy
// Copy the *.deno.dev URL → set as EBAY_WORKER_URL in Render env vars

const HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  if (!q) return Response.json({ error: "missing ?q=" }, { status: 400 });

  // Step 1: get session cookies from eBay home
  const homeResp = await fetch("https://www.ebay.com/", {
    headers: { ...HEADERS, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "sec-fetch-user": "?1" },
    redirect: "follow",
  });
  const cookie = homeResp.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ");

  // Step 2: fetch sold listings with those cookies
  const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=12&_ipg=25`;
  const resp = await fetch(ebayUrl, {
    headers: { ...HEADERS, "Referer": "https://www.ebay.com/", "Cookie": cookie, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", "sec-fetch-user": "?1" },
    redirect: "follow",
  });

  const html = await resp.text();
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
});
