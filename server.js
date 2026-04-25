const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
app.use(cors());
app.use(express.json());

process.on("uncaughtException", (err) => console.error("Uncaught:", err.message));
process.on("unhandledRejection", (r) => console.error("Rejection:", r));

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health` : null;
if (SELF_URL) setInterval(() => axios.get(SELF_URL,{timeout:5000}).catch(()=>{}), 4*60*1000);

// ── Config ────────────────────────────────────────────────────────────────────
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || "";
const BASE = "https://www.mvlempyr.io";

// Route through ScraperAPI to bypass Cloudflare
function wrap(url) {
  if (!SCRAPER_KEY) return url;
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=true`;
}

async function fetchPage(url, ttl = 3600) {
  const cached = cache.get(url);
  if (cached) return cached;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(wrap(url), {
        timeout: 30000,
        maxRedirects: 5,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" }
      });
      if (res.status === 200 && res.data) {
        cache.set(url, res.data, ttl);
        return res.data;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, i * 2000));
    }
  }
  throw new Error(`Failed: ${lastErr?.message}`);
}

function safeLoad(html) {
  try { return cheerio.load(html || ""); } catch { return cheerio.load(""); }
}

// ── Rankings ──────────────────────────────────────────────────────────────────
// MVLempyr rankings: /rankings?page=1&rank=weekly|monthly|alltime|trending
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const type = req.params.type;
    const rankMap = { daily: "trending", weekly: "weekly", monthly: "monthly", popular: "alltime" };
    const rank = rankMap[type] || "alltime";

    const html = await fetchPage(`${BASE}/rankings?page=1&rank=${rank}`);
    const $ = safeLoad(html);
    const novels = [];

    // MVLempyr uses React/Next.js — try multiple selectors
    $("[class*='novel'], [class*='card'], [class*='item'], article, .grid > div").each((i, el) => {
      if (i >= 30) return false;
      const $el = $(el);
      const a = $el.find("a[href*='/novel/']").first();
      const title = a.attr("title") || a.text().trim() || $el.find("h2, h3, [class*='title']").first().text().trim();
      const href = a.attr("href") || "";
      const slug = href.split("/novel/")[1]?.split("/")[0] || "";
      const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
      if (title && slug) novels.push({ rank: i+1, title, slug, cover, latestChapter: "" });
    });

    // Fallback: grab all /novel/ links from page
    if (novels.length === 0) {
      const seen = new Set();
      $("a[href*='/novel/']").each((i, el) => {
        if (novels.length >= 30) return false;
        const href = $(el).attr("href") || "";
        const slug = href.split("/novel/")[1]?.split("/")[0] || "";
        const title = $(el).attr("title") || $(el).text().trim();
        const cover = $(el).find("img").first().attr("src") || "";
        if (slug && title && title.length > 2 && !seen.has(slug)) {
          seen.add(slug);
          novels.push({ rank: novels.length+1, title, slug, cover, latestChapter: "" });
        }
      });
    }

    res.json({ ok: true, type, novels });
  } catch (e) {
    console.error("/api/rankings error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Latest ────────────────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    const html = await fetchPage(`${BASE}/novels`, 1800);
    const $ = safeLoad(html);
    const novels = [];
    const seen = new Set();

    $("a[href*='/novel/']").each((i, el) => {
      if (novels.length >= 20) return false;
      const href = $(el).attr("href") || "";
      const slug = href.split("/novel/")[1]?.split("/")[0] || "";
      const title = $(el).attr("title") || $(el).text().trim();
      const cover = $(el).find("img").first().attr("src") || "";
      if (slug && title && title.length > 2 && !seen.has(slug)) {
        seen.add(slug);
        novels.push({ title, slug, cover, latestChapter: "" });
      }
    });

    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Novel detail ──────────────────────────────────────────────────────────────
app.get("/api/novel/:slug", async (req, res) => {
  try {
    const slug = (req.params.slug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!slug) return res.status(400).json({ ok: false, error: "Invalid slug" });

    const html = await fetchPage(`${BASE}/novel/${slug}`);
    const $ = safeLoad(html);

    const title = $("h1, [class*='title']").first().text().trim();
    const cover = $("img[class*='cover'], img[class*='thumbnail'], .cover img, img[alt]").first().attr("src") || "";
    const author = $("[class*='author'] a, [class*='author']").first().text().trim();
    const description = $("[class*='description'], [class*='synopsis'], [class*='summary']").first().text().trim().slice(0, 1200);
    const genres = [];
    $("a[href*='/genre/'], a[href*='/tag/'], [class*='tag'], [class*='genre']").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g) && genres.length < 10) genres.push(g);
    });

    // Get chapters — MVLempyr chapter links follow /chapter/ID format
    const chapters = [];
    $("a[href*='/chapter/']").each((i, el) => {
      if (i >= 200) return false;
      const href = $(el).attr("href") || "";
      // Extract chapter ID from href like /chapter/5646-1
      const chSlug = href.split("/chapter/")[1]?.split("/")[0] || "";
      const name = $(el).text().trim() || `Chapter ${i+1}`;
      if (chSlug) chapters.push({ index: i, name, slug: chSlug, href: href.startsWith("http") ? href : `${BASE}${href}` });
    });

    res.json({ ok: true, novel: { title, cover, author, status: "Unknown", genres, description, rating: "", chapters, slug }});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapter list paginated ────────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const slug = (req.params.slug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const page = Math.min(Math.max(parseInt(req.query.page)||1,1),200);
    const html = await fetchPage(`${BASE}/novel/${slug}?page=${page}`, 1800);
    const $ = safeLoad(html);
    const chapters = [];
    $("a[href*='/chapter/']").each((i, el) => {
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/chapter/")[1]?.split("/")[0] || "";
      const name = $(el).text().trim() || `Chapter ${(page-1)*50+i+1}`;
      if (chSlug) chapters.push({ index: (page-1)*50+i, name, slug: chSlug, href: href.startsWith("http")?href:`${BASE}${href}` });
    });
    res.json({ ok: true, chapters });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
// MVLempyr chapters: /chapter/CHAPTER-ID (e.g. /chapter/5646-1)
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const novelSlug = (req.params.novelSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const chapterSlug = (req.params.chapterSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!novelSlug || !chapterSlug) return res.status(400).json({ ok: false, error: "Invalid" });

    // MVLempyr chapter URLs: /chapter/{id}
    const html = await fetchPage(`${BASE}/chapter/${chapterSlug}`, 7200);
    const $ = safeLoad(html);

    const title = $("h1, [class*='chapter-title'], [class*='title']").first().text().trim();

    // MVLempyr chapter content is in #chapter per WebToEpub research
    $("script, style, .ads, iframe, noscript, [class*='ads'], [class*='popup']").remove();

    let content = "";
    // Try known selector first
    const contentEl = $("#chapter, [class*='chapter-content'], [class*='content']").first();
    if (contentEl.length) {
      const parts = [];
      contentEl.find("p").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 0) parts.push(t);
      });
      content = parts.length > 0 ? parts.join("\n\n") : contentEl.text().trim();
    }

    // Fallback: all paragraphs
    if (content.length < 100) {
      const parts = [];
      $("p").each((_, el) => { const t=$(el).text().trim(); if(t.length>20) parts.push(t); });
      content = parts.join("\n\n");
    }

    // Next/prev
    const prevHref = $("a[href*='/chapter/'][class*='prev'], a:contains('Previous'), a[rel='prev']").attr("href") || "";
    const nextHref = $("a[href*='/chapter/'][class*='next'], a:contains('Next'), a[rel='next']").attr("href") || "";
    const prevSlug = prevHref.split("/chapter/")[1]?.split("/")[0] || "";
    const nextSlug = nextHref.split("/chapter/")[1]?.split("/")[0] || "";

    res.json({ ok: true, title, content, novelSlug, prevSlug, nextSlug });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 100);
    if (!q) return res.json({ ok: true, novels: [] });

    const html = await fetchPage(`${BASE}/novels?search=${encodeURIComponent(q)}`, 300);
    const $ = safeLoad(html);
    const novels = [];
    const seen = new Set();

    $("a[href*='/novel/']").each((i, el) => {
      if (novels.length >= 20) return false;
      const href = $(el).attr("href") || "";
      const slug = href.split("/novel/")[1]?.split("/")[0] || "";
      const title = $(el).attr("title") || $(el).text().trim();
      const cover = $(el).find("img").first().attr("src") || "";
      if (slug && title && title.length > 2 && !seen.has(slug)) {
        seen.add(slug);
        novels.push({ title, slug, cover });
      }
    });

    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  source: "MVLempyr",
  scraperApi: SCRAPER_KEY ? "enabled" : "NOT SET — add SCRAPER_API_KEY in Railway Variables"
}));
app.use((_, res) => res.status(404).json({ ok: false, error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OneMoreChapter proxy on port ${PORT}`);
  console.log(`Source: MVLempyr | ScraperAPI: ${SCRAPER_KEY ? "ENABLED ✓" : "NOT SET ✗"}`);
});
