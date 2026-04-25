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

// ── Source: FreeWebNovel — no Cloudflare, freely accessible ──────────────────
const BASE = "https://freewebnovel.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://freewebnovel.com/",
  "Connection": "keep-alive",
};

async function fetchPage(url, ttl = 3600) {
  const cached = cache.get(url);
  if (cached) return cached;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000, maxRedirects: 5 });
      if (res.status === 200 && res.data) {
        cache.set(url, res.data, ttl);
        return res.data;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, i * 1500));
    }
  }
  throw new Error(`Failed: ${lastErr?.message}`);
}

function safeLoad(html) {
  try { return cheerio.load(html || ""); } catch { return cheerio.load(""); }
}

function parseNovels($, limit = 30) {
  const novels = [];
  // FreeWebNovel novel list selectors
  $(".ul-list1 li, .list-novel .item, .novel-item, .col-12.col-sm-6.col-md-4").each((i, el) => {
    if (i >= limit) return false;
    const $el = $(el);
    const a = $el.find("a[href*='.htm'], a[href*='/novel/']").first();
    const title = a.attr("title") || a.text().trim() || $el.find("h3, .title").first().text().trim();
    const href = a.attr("href") || "";
    // slug from URL like /martial-world.htm or /novel/martial-world
    const slug = href.replace(/^\//, "").replace(".htm", "").split("/").pop() || "";
    const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
    const chapter = $el.find(".chapter, .last-chapter").first().text().trim();
    if (title && slug && slug.length > 1) {
      novels.push({ title, slug, cover: cover.startsWith("http") ? cover : cover ? `${BASE}${cover}` : "", latestChapter: chapter });
    }
  });
  return novels;
}

// ── Rankings ──────────────────────────────────────────────────────────────────
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const type = req.params.type;
    // FreeWebNovel ranking pages
    const urlMap = {
      daily:   `${BASE}/most-popular-novel/`,
      weekly:  `${BASE}/most-popular-novel/`,
      monthly: `${BASE}/most-popular-novel/`,
      popular: `${BASE}/most-popular-novel/`,
    };
    const html = await fetchPage(urlMap[type] || urlMap.popular);
    const $ = safeLoad(html);
    let novels = parseNovels($, 30);

    // Fallback selectors if main ones miss
    if (novels.length === 0) {
      $(".li-row, .novel-list li, article").each((i, el) => {
        if (i >= 30) return false;
        const $el = $(el);
        const a = $el.find("a").first();
        const title = a.attr("title") || a.text().trim();
        const href = a.attr("href") || "";
        const slug = href.replace(/^\//, "").replace(".htm","").split("/").pop() || "";
        const cover = $el.find("img").first().attr("src") || "";
        if (title && slug && slug.length > 1) novels.push({ title, slug, cover, latestChapter: "" });
      });
    }

    res.json({ ok: true, type, novels: novels.map((n, i) => ({ ...n, rank: i+1 })) });
  } catch (e) {
    console.error("/rankings error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Latest ────────────────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    const html = await fetchPage(`${BASE}/latest-release-novel/`, 1800);
    const $ = safeLoad(html);
    const novels = parseNovels($, 20);
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

    const html = await fetchPage(`${BASE}/${slug}.htm`);
    const $ = safeLoad(html);

    const title = $("h1.tit, .book-name, h1").first().text().trim();
    const cover = $(".pic img, .book-img img, .cover img").first().attr("src") || "";
    const author = $("a[href*='author'], .author a, .writer a").first().text().trim();
    const status = $(".ongoing, .completed, .book-state").first().text().trim();
    const description = $(".inner, .description, #bookSummary").first().text().trim().slice(0, 1200);
    const genres = [];
    $("a[href*='genre'], a[href*='category'], .tag a").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g) && genres.length < 10) genres.push(g);
    });

    const chapters = [];
    $(".ul-list2 li a, #chapterList li a, .chapter-list li a, .list-chapter li a").each((i, el) => {
      if (i >= 150) return false;
      const href = $(el).attr("href") || "";
      const chSlug = href.replace(/^\//, "").replace(".htm", "").split("/").pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: i, name, slug: chSlug, href: href.startsWith("http") ? href : `${BASE}/${href.replace(/^\//,"")}` });
    });

    res.json({ ok: true, novel: { title, cover: cover.startsWith("http")?cover:cover?`${BASE}${cover}`:"", author, status, genres, description, rating: "", chapters, slug }});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapter list paginated ────────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const slug = (req.params.slug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    const page = Math.min(Math.max(parseInt(req.query.page)||1,1),200);
    const html = await fetchPage(`${BASE}/${slug}.htm?page=${page}`, 1800);
    const $ = safeLoad(html);
    const chapters = [];
    $(".ul-list2 li a, #chapterList li a, .chapter-list li a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const chSlug = href.replace(/^\//, "").replace(".htm","").split("/").pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: (page-1)*50+i, name, slug: chSlug, href: href.startsWith("http")?href:`${BASE}/${href.replace(/^\//,"")}` });
    });
    res.json({ ok: true, chapters });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const novelSlug = (req.params.novelSlug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    const chapterSlug = (req.params.chapterSlug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    if (!novelSlug || !chapterSlug) return res.status(400).json({ ok: false, error: "Invalid" });

    // FreeWebNovel chapter URLs: /novel-slug/chapter-slug.htm
    const html = await fetchPage(`${BASE}/${novelSlug}/${chapterSlug}.htm`, 7200);
    const $ = safeLoad(html);

    const title = $(".chapter-title, h1, .tit").first().text().trim();
    $("script, style, .ads, iframe, noscript, .adsbygoogle, .recommend-list, .comment").remove();

    let content = "";
    const contentEl = $(".chapter-content, #chapter-content, #content, .text-left").first();
    if (contentEl.length) {
      const parts = [];
      contentEl.find("p").each((_, el) => { const t=$(el).text().trim(); if(t.length>0) parts.push(t); });
      content = parts.length > 0 ? parts.join("\n\n") : contentEl.text().trim();
    }
    if (content.length < 100) {
      const parts = [];
      $("p").each((_, el) => { const t=$(el).text().trim(); if(t.length>20) parts.push(t); });
      content = parts.join("\n\n");
    }

    const prevHref = $("a.pre, a[rel='prev'], a:contains('Previous')").attr("href") || "";
    const nextHref = $("a.nxt, a[rel='next'], a:contains('Next')").attr("href") || "";
    const prevSlug = prevHref.replace(/^\//, "").replace(".htm","").split("/").pop() || "";
    const nextSlug = nextHref.replace(/^\//, "").replace(".htm","").split("/").pop() || "";

    res.json({ ok: true, title, content, novelSlug, prevSlug, nextSlug });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q||"").trim().slice(0,100);
    if (!q) return res.json({ ok: true, novels: [] });
    const html = await fetchPage(`${BASE}/search/?searchkey=${encodeURIComponent(q)}`, 300);
    const $ = safeLoad(html);
    const novels = parseNovels($, 20);
    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, uptime: process.uptime(), source: "FreeWebNovel" }));
app.use((_, res) => res.status(404).json({ ok: false, error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`OneMoreChapter proxy on port ${PORT} | Source: FreeWebNovel`));
