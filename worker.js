// Cloudflare Worker — eBay sold listings proxy
// Deploy at: dash.cloudflare.com → Workers & Pages → Create Worker
// Paste this code, click Deploy, copy the *.workers.dev URL
// Then add EBAY_WORKER_URL=https://your-worker.workers.dev to Render env vars

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    if (!q) return Response.json({ error: "missing ?q=" }, { status: 400 });

    const ebayUrl =
      `https://www.ebay.com/sch/i.html` +
      `?_nkw=${encodeURIComponent(q)}` +
      `&LH_Sold=1&LH_Complete=1` +   // sold listings only
      `&_sop=12` +                    // sort: recently ended
      `&_ipg=25`;                     // 25 results per page

    const resp = await fetch(ebayUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    const html = await resp.text();
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Ebay-Status": String(resp.status),
      },
    });
  },
};
