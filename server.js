const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");
 
const app = express();

// ── Cache: 1hr for pages, 10min for chapters ──────────────────────────────────
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

app.use(cors());
app.use(express.json());

// ── Keep-alive: ping self every 4 minutes so Railway doesn't sleep ────────────
// (Railway free tier kills idle processes)
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : null;

if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL, { timeout: 5000 }).catch(() => {});
  }, 4 * 60 * 1000); // every 4 minutes
}

// ── Global unhandled error guards — CRITICAL, prevents crashes ────────────────
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception (server kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection (server kept alive):", reason);
});

const BASE = "https://novelbin.me";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://novelbin.me/",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

// ── Safe fetch with timeout + retry ──────────────────────────────────────────
async function fetchPage(url, ttl = 3600) {
  const cached = cache.get(url);
  if (cached) return cached;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: HEADERS,
        timeout: 15000,           // 15s timeout (was 10s — too short)
        maxRedirects: 5,
        validateStatus: (s) => s < 500, // don't throw on 4xx
      });
      if (res.status === 200 && res.data) {
        cache.set(url, res.data, ttl);
        return res.data;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastErr.message}`);
}

// ── Safe cheerio load — prevents crash on bad HTML ───────────────────────────
function safeLoad(html) {
  try {
    return cheerio.load(html || "");
  } catch (e) {
    return cheerio.load("");
  }
}

// ── Rankings ──────────────────────────────────────────────────────────────────
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const type = ["daily","weekly","monthly","popular"].includes(req.params.type)
      ? req.params.type : "popular";

    const urlMap = {
      daily:   `${BASE}/most-popular?time=daily`,
      weekly:  `${BASE}/most-popular?time=weekly`,
      monthly: `${BASE}/most-popular?time=monthly`,
      popular: `${BASE}/most-popular`,
    };

    const html = await fetchPage(urlMap[type]);
    const $ = safeLoad(html);
    const novels = [];

    $(".col-novel-main .list-novel .row").each((i, el) => {
      if (i >= 30) return false;
      const $el = $(el);
      const titleEl = $el.find(".novel-title a");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || "";
      const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
      const chapter = $el.find(".chr-text, .chapter-text").first().text().trim();
      if (title && slug) novels.push({ rank: i+1, title, slug, cover, latestChapter: chapter });
    });

    // Fallback selectors
    if (novels.length === 0) {
      $(".novel-item, .list-novel .item, .row-novel, .col-truyen-main .list-truyen .row").each((i, el) => {
        if (i >= 30) return false;
        const $el = $(el);
        const a = $el.find("a[href*='novel-book']").first();
        const title = a.attr("title") || a.text().trim();
        const href = a.attr("href") || "";
        const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || href.split("/").filter(Boolean).pop() || "";
        const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
        if (title && slug) novels.push({ rank: i+1, title, slug, cover, latestChapter: "" });
      });
    }

    res.json({ ok: true, type, novels });
  } catch (e) {
    console.error("/api/rankings error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Novel detail ──────────────────────────────────────────────────────────────
app.get("/api/novel/:slug", async (req, res) => {
  try {
    const slug = (req.params.slug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!slug) return res.status(400).json({ ok: false, error: "Invalid slug" });

    const html = await fetchPage(`${BASE}/novel-book/${slug}`);
    const $ = safeLoad(html);

    const title = $("h3.title, .book-name, h1.novel-title, h1").first().text().trim();
    const cover = $(".book-img img, .novel-cover img, .info-holder img").first().attr("src")
      || $(".book-img img").first().attr("data-src") || "";
    const author = $(".author span, a[href*='author'], .info-holder .author a").first().text().trim();
    const status = $(".info-holder .info-item .info-value").filter((_, el) => {
      return $(el).prev().text().toLowerCase().includes("status");
    }).first().text().trim() || "Unknown";

    const genres = [];
    $(".categories a, .genre-item a, a[href*='genre'], .info-holder a[href*='genre']").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g) && genres.length < 10) genres.push(g);
    });

    const description = $(".desc-text, #novel-body, .summary__content, .description, .intro").first().text().trim().slice(0, 1200);
    const rating = $(".score, .rate-star-count, .book-rate-point").first().text().trim();

    const chapters = [];
    $(".list-chapter li a, .chapter-list li a, ul.list-chapter a, #list-chapter .row a").each((i, el) => {
      if (i >= 100) return false;
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").filter(Boolean).pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: i, name, slug: chSlug, href });
    });

    res.json({ ok: true, novel: { title, cover, author, status, genres, description, rating, chapters, slug } });
  } catch (e) {
    console.error("/api/novel error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapter list paginated ────────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const slug = (req.params.slug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), 100);
    const html = await fetchPage(`${BASE}/novel-book/${slug}?page=${page}`, 1800);
    const $ = safeLoad(html);
    const chapters = [];
    $(".list-chapter li a, .chapter-list li a, ul.list-chapter a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").filter(Boolean).pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: (page-1)*50+i, name, slug: chSlug, href });
    });
    res.json({ ok: true, chapters });
  } catch (e) {
    console.error("/api/chapters error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const novelSlug = (req.params.novelSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const chapterSlug = (req.params.chapterSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!novelSlug || !chapterSlug) return res.status(400).json({ ok: false, error: "Invalid params" });

    const url = `${BASE}/novel-book/${novelSlug}/${chapterSlug}`;
    const html = await fetchPage(url, 7200); // cache chapters 2hrs
    const $ = safeLoad(html);

    const title = $(".chr-title, .chapter-title, h2.title-chapter, h2").first().text().trim();

    // Strip noise
    $("script, style, .ads, .adsbygoogle, #pop-up, .popup, .btn-read-novel, .action-bar, iframe, noscript, .chapter-nav").remove();

    let content = "";
    const contentSelectors = ["#chr-content", ".chr-c", ".chapter-content", "#chapterContent", ".content-body", "#vung_doc", ".vung_doc"];
    for (const sel of contentSelectors) {
      const el = $(sel).first();
      if (el.length) {
        content = el.text().trim();
        if (content.length > 100) break;
      }
    }
    // Last resort: grab all paragraphs
    if (content.length < 100) {
      const parts = [];
      $("p").each((_, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 20) parts.push(txt);
      });
      content = parts.join("\n\n");
    }

    const prevHref = $("a#prev_chap, a.chr-prev, a[rel='prev'], .chr-nav-prev a").attr("href") || "";
    const nextHref = $("a#next_chap, a.chr-next, a[rel='next'], .chr-nav-next a").attr("href") || "";
    const prevSlug = prevHref.split("/").filter(Boolean).pop() || "";
    const nextSlug = nextHref.split("/").filter(Boolean).pop() || "";

    res.json({ ok: true, title, content, prevSlug, nextSlug, novelSlug });
  } catch (e) {
    console.error("/api/chapter error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 100);
    if (!q) return res.json({ ok: true, novels: [] });

    const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(q)}&post_type=novel`, 300);
    const $ = safeLoad(html);
    const novels = [];

    $(".col-novel-main .list-novel .row, .search-results .item, .list-truyen .row").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const a = $el.find(".novel-title a, a[href*='novel-book']").first();
      const title = a.text().trim() || a.attr("title") || "";
      const href = a.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || "";
      const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
      if (title && slug) novels.push({ title, slug, cover });
    });

    res.json({ ok: true, novels });
  } catch (e) {
    console.error("/api/search error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Latest releases ───────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    const html = await fetchPage(`${BASE}/latest-release-novel`, 1800);
    const $ = safeLoad(html);
    const novels = [];
    $(".col-novel-main .list-novel .row").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const a = $el.find(".novel-title a").first();
      const title = a.text().trim();
      const href = a.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || "";
      const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
      const chapter = $el.find(".chr-text, .chapter-text").first().text().trim();
      if (title && slug) novels.push({ title, slug, cover, latestChapter: chapter });
    });
    res.json({ ok: true, novels });
  } catch (e) {
    console.error("/api/latest error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ ok: false, error: "Not found" }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OneMoreChapter proxy running on port ${PORT}`);
  console.log(`Keep-alive pinging: ${SELF_URL || "disabled (set RAILWAY_PUBLIC_DOMAIN)"}`);
});
