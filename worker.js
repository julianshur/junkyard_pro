// Cloudflare Worker — eBay sold listings proxy
// Two-step: get session cookies from eBay home, then search with them

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    if (!q) return Response.json({ error: "missing ?q=" }, { status: 400 });

    // Step 1: hit eBay home to collect session cookies
    const homeResp = await fetch("https://www.ebay.com/", {
      headers: {
        ...HEADERS,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
      },
      redirect: "follow",
    });

    const rawCookies = homeResp.headers.getSetCookie?.() ?? [];
    const cookie = rawCookies.map(c => c.split(";")[0]).join("; ");

    // Step 2: search sold listings with those cookies
    const ebayUrl =
      `https://www.ebay.com/sch/i.html` +
      `?_nkw=${encodeURIComponent(q)}` +
      `&LH_Sold=1&LH_Complete=1` +
      `&_sop=12&_ipg=25`;

    const resp = await fetch(ebayUrl, {
      headers: {
        ...HEADERS,
        "Referer": "https://www.ebay.com/",
        "Cookie": cookie,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
      },
      redirect: "follow",
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
