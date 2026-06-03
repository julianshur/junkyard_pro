import Anthropic from "@anthropic-ai/sdk";
import { getCachedBuckets, putBucket } from "./db.js";
import { FLAT_RATES } from "./pyp.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";

// PYP prices by flat-rate bucket, so a title must map to one of these EXACT
// keys (or null) for the price lookup to work.
const CATEGORIES = Object.keys(FLAT_RATES);
const CATEGORY_SET = new Set(CATEGORIES.map((c) => c.toUpperCase()));

// Given many eBay titles, return Map(title -> bucket|null). Hits the title
// cache first; only unseen titles cost a Haiku call, and the answer (incl.
// null, stored as "") is cached so we never re-classify the same title.
export async function classifyTitles(titles) {
  const unique = [...new Set(titles)];
  const result = await getCachedBuckets(unique);

  const missing = unique.filter((t) => !result.has(t));
  for (const title of missing) {
    const bucket = await classifyOne(title);
    result.set(title, bucket);
    await putBucket(title, bucket || "");
  }
  return result;
}

async function classifyOne(title) {
  const prompt =
    `Map this eBay auto-part listing title to a PYP flat-rate category.\n\n` +
    `Title: "${title}"\n\n` +
    `Pick the SINGLE best category from this exact list (copy it verbatim, ` +
    `including punctuation and capitalization). If the listing is not one of ` +
    `these parts (e.g. a whole car, a manual, a lot of mixed items, an ` +
    `accessory), return null.\n\n` +
    `CATEGORIES:\n${CATEGORIES.join("\n")}\n\n` +
    `Return ONLY JSON: {"category":"<exact category or null>"}`;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    return normalizeCategory(JSON.parse(raw).category);
  } catch (e) {
    console.error(`  classify failed for "${title.slice(0, 60)}": ${e.message}`);
    return null;
  }
}

function normalizeCategory(value) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim();
  if (FLAT_RATES[v] !== undefined) return v;
  if (CATEGORY_SET.has(v.toUpperCase())) {
    return CATEGORIES.find((c) => c.toUpperCase() === v.toUpperCase());
  }
  return null;
}
