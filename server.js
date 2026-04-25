const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

app.use(cors());
app.use(express.json());

const BASE = "https://novelbin.me";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Referer": "https://novelbin.me/",
};

async function fetchPage(url) {
  const cached = cache.get(url);
  if (cached) return cached;
  const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  cache.set(url, res.data);
  return res.data;
}

// ── Rankings ──────────────────────────────────────────────────────────────────
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const { type } = req.params; // daily | weekly | monthly | popular
    const urlMap = {
      daily:   `${BASE}/sort/novelbin-daily`,
      weekly:  `${BASE}/sort/novelbin-weekly`,
      monthly: `${BASE}/sort/novelbin-monthly`,
      popular: `${BASE}/sort/novelbin-popular`,
    };
    const url = urlMap[type] || urlMap.popular;
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
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
      const views = $el.find(".novel-views, .eyes span").first().text().trim();

      if (title && slug) {
        novels.push({ rank: i + 1, title, slug, cover, latestChapter: chapter, views });
      }
    });

    // fallback parse if structure differs
    if (novels.length === 0) {
      $(".novel-item, .list-novel .item, .row-novel").each((i, el) => {
        if (i >= 30) return false;
        const $el = $(el);
        const a = $el.find("a[href*='novel-book']").first();
        const title = a.attr("title") || a.text().trim();
        const href = a.attr("href") || "";
        const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || href.split("/").pop() || "";
        const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
        if (title && slug) novels.push({ rank: i + 1, title, slug, cover, latestChapter: "", views: "" });
      });
    }

    res.json({ ok: true, type, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Novel detail ──────────────────────────────────────────────────────────────
app.get("/api/novel/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const html = await fetchPage(`${BASE}/novel-book/${slug}`);
    const $ = cheerio.load(html);

    const title = $("h3.title, .book-name, h1").first().text().trim();
    const cover = $(".book-img img, .novel-cover img").attr("src") || $(".book-img img").attr("data-src") || "";
    const author = $(".author span, a[href*='author']").first().text().trim();
    const status = $(".header-stats span:contains('Status') ~ span, .info-item:contains('Status')").text().trim() || "Unknown";
    const genres = [];
    $(".categories a, .genre-item a, a[href*='genre']").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });
    const description = $(".desc-text, #novel-body, .summary__content, .description").first().text().trim().slice(0, 1000);
    const rating = $(".score, .rate-star-count").first().text().trim();

    // Chapter list
    const chapters = [];
    $(".list-chapter li a, .chapter-list li a, ul.list-chapter a").each((i, el) => {
      if (i >= 50) return false;
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").pop() || href.split("/chapter/")[1] || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: i, name, slug: chSlug, href });
    });

    res.json({ ok: true, novel: { title, cover, author, status, genres, description, rating, chapters, slug } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapter list (paginated) ──────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const { slug } = req.params;
    const page = parseInt(req.query.page) || 1;
    const html = await fetchPage(`${BASE}/novel-book/${slug}?page=${page}`);
    const $ = cheerio.load(html);
    const chapters = [];
    $(".list-chapter li a, .chapter-list li a, ul.list-chapter a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: (page - 1) * 50 + i, name, slug: chSlug, href });
    });
    res.json({ ok: true, chapters });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const { novelSlug, chapterSlug } = req.params;
    const url = `${BASE}/novel-book/${novelSlug}/${chapterSlug}`;
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    const title = $(".chr-title, .chapter-title, h2").first().text().trim();

    // Remove ads / junk
    $("script, style, .ads, .adsbygoogle, #pop-up, .popup, .btn-read-novel, .action-bar").remove();

    let content = "";
    const contentEl = $("#chr-content, .chr-c, .chapter-content, #chapterContent, .content-body");
    if (contentEl.length) {
      content = contentEl.first().text().trim();
    } else {
      $("p").each((_, el) => { content += $(el).text().trim() + "\n\n"; });
    }

    // Next / prev links
    const prevHref = $("a#prev_chap, a.chr-prev, a[rel='prev']").attr("href") || "";
    const nextHref = $("a#next_chap, a.chr-next, a[rel='next']").attr("href") || "";
    const prevSlug = prevHref.split("/").pop() || "";
    const nextSlug = nextHref.split("/").pop() || "";

    res.json({ ok: true, title, content, prevSlug, nextSlug, novelSlug });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ ok: true, novels: [] });
    const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(q)}&post_type=novel`);
    const $ = cheerio.load(html);
    const novels = [];
    $(".col-novel-main .list-novel .row, .search-results .item").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const a = $el.find(".novel-title a, a[href*='novel-book']").first();
      const title = a.text().trim() || a.attr("title");
      const href = a.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.replace(/\/$/, "") || "";
      const cover = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";
      if (title && slug) novels.push({ title, slug, cover });
    });
    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Latest releases ───────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    const html = await fetchPage(`${BASE}/sort/novelbin-new-manga`);
    const $ = cheerio.load(html);
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
