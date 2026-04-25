const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

app.use(cors());
app.use(express.json());

// ── Keep-alive ping ───────────────────────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : null;
if (SELF_URL) {
  setInterval(() => axios.get(SELF_URL, { timeout: 5000 }).catch(() => {}), 4 * 60 * 1000);
}

// ── Crash guards ──────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => console.error("Uncaught:", err.message));
process.on("unhandledRejection", (reason) => console.error("Rejection:", reason));

// ── NovelBin API base (their internal API, not blocked by Cloudflare) ─────────
const API_BASE = "https://novelbin.com/api";
const WEB_BASE = "https://novelbin.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://novelbin.com",
  "Referer": "https://novelbin.com/",
  "X-Requested-With": "XMLHttpRequest",
};

const WEB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://novelbin.com/",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
};

async function apiGet(url, ttl = 3600) {
  const cached = cache.get(url);
  if (cached) return cached;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000, maxRedirects: 5 });
      if (res.data) { cache.set(url, res.data, ttl); return res.data; }
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, i * 1500));
    }
  }
  throw new Error(`Failed: ${lastErr?.message}`);
}

async function webGet(url, ttl = 3600) {
  const cached = cache.get(url);
  if (cached) return cached;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(url, { headers: WEB_HEADERS, timeout: 15000, maxRedirects: 5 });
      if (res.data) { cache.set(url, res.data, ttl); return res.data; }
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, i * 1500));
    }
  }
  throw new Error(`Failed: ${lastErr?.message}`);
}

// ── Rankings ──────────────────────────────────────────────────────────────────
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const type = req.params.type;
    const typeMap = { daily: "daily", weekly: "weekly", monthly: "monthly", popular: "all" };
    const t = typeMap[type] || "weekly";

    // Try NovelBin API first
    try {
      const data = await apiGet(`${API_BASE}/novel-rank?rank=${t}&page=1`);
      if (data && (data.data || Array.isArray(data))) {
        const list = data.data || data;
        const novels = list.slice(0, 30).map((n, i) => ({
          rank: i + 1,
          title: n.name || n.title || "",
          slug: n.slug || n.id || "",
          cover: n.cover || n.image || "",
          latestChapter: n.last_chapter || "",
          views: n.views || "",
        }));
        return res.json({ ok: true, type, novels });
      }
    } catch (e) { console.log("API attempt failed, trying web:", e.message); }

    // Fallback: try scraping with cheerio
    const cheerio = require("cheerio");
    const urlMap = {
      daily: `${WEB_BASE}/most-popular?time=daily`,
      weekly: `${WEB_BASE}/most-popular?time=weekly`,
      monthly: `${WEB_BASE}/most-popular?time=monthly`,
      popular: `${WEB_BASE}/most-popular`,
    };
    const html = await webGet(urlMap[type] || urlMap.popular);
    const $ = cheerio.load(html);
    const novels = [];

    // Try multiple selectors
    const selectors = [
      ".list.list-novel .row",
      ".col-novel-main .list-novel .row",
      ".list-novel .row",
      ".novel-item",
      "li.novel-item",
      ".truyen-list .row",
    ];

    for (const sel of selectors) {
      $(sel).each((i, el) => {
        if (i >= 30) return false;
        const $el = $(el);
        const a = $el.find("h3.novel-title a, .novel-title a, a[href*='novel-book']").first();
        const title = a.text().trim() || a.attr("title") || "";
        const href = a.attr("href") || "";
        const slug = href.includes("novel-book")
          ? href.split("/novel-book/")[1]?.split("/")[0] || ""
          : href.split("/").filter(Boolean).pop() || "";
        const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
        const chapter = $el.find(".chr-text, .chapter-text, .text-info").first().text().trim();
        if (title && slug) novels.push({ rank: i + 1, title, slug, cover, latestChapter: chapter });
      });
      if (novels.length > 0) break;
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

    // Try API first
    try {
      const data = await apiGet(`${API_BASE}/novel-detail/${slug}`);
      if (data && data.name) {
        const chapters = (data.chapters || []).slice(0, 100).map((ch, i) => ({
          index: i, name: ch.name || `Chapter ${i+1}`,
          slug: ch.slug || ch.id || "", href: ch.href || "",
        }));
        return res.json({ ok: true, novel: {
          title: data.name, cover: data.cover || data.image || "",
          author: data.author || "", status: data.status || "Unknown",
          genres: data.genres || data.tags || [],
          description: (data.description || data.synopsis || "").slice(0, 1200),
          rating: data.rating || "", chapters, slug,
        }});
      }
    } catch (e) { console.log("Novel API failed, scraping:", e.message); }

    // Fallback scrape
    const cheerio = require("cheerio");
    const html = await webGet(`${WEB_BASE}/novel-book/${slug}`);
    const $ = cheerio.load(html);

    const title = $("h3.title, .book-name, h1.novel-title, .info-holder h3, h1").first().text().trim();
    const cover = $(".book-img img, .novel-cover img, .info-holder img, .book-img-wrapper img").first().attr("src")
      || $(".book-img img").first().attr("data-src") || "";
    const author = $("a[href*='author'], .author a, .info-holder .author").first().text().trim();
    const description = $(".desc-text, #novel-body, .summary__content, .description, .synopsis").first().text().trim().slice(0, 1200);
    const genres = [];
    $("a[href*='genre'], .categories a, .tag a").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g) && genres.length < 8) genres.push(g);
    });

    const chapters = [];
    $(".list-chapter li a, ul.list-chapter a, #list-chapter a, .chapter-list a").each((i, el) => {
      if (i >= 100) return false;
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").filter(Boolean).pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: i, name, slug: chSlug, href });
    });

    res.json({ ok: true, novel: { title, cover, author, status: "Unknown", genres, description, rating: "", chapters, slug } });
  } catch (e) {
    console.error("/api/novel error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapters paginated ────────────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const slug = (req.params.slug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), 200);

    try {
      const data = await apiGet(`${API_BASE}/chapter-list/${slug}?page=${page}`);
      if (data && (data.data || Array.isArray(data))) {
        const list = data.data || data;
        const chapters = list.map((ch, i) => ({
          index: (page-1)*50+i, name: ch.name || `Chapter ${(page-1)*50+i+1}`,
          slug: ch.slug || ch.id || "", href: ch.href || "",
        }));
        return res.json({ ok: true, chapters });
      }
    } catch (e) {}

    const cheerio = require("cheerio");
    const html = await webGet(`${WEB_BASE}/novel-book/${slug}?page=${page}`, 1800);
    const $ = cheerio.load(html);
    const chapters = [];
    $(".list-chapter li a, ul.list-chapter a, #list-chapter a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const chSlug = href.split("/").filter(Boolean).pop() || "";
      const name = $(el).text().trim();
      if (name && chSlug) chapters.push({ index: (page-1)*50+i, name, slug: chSlug, href });
    });
    res.json({ ok: true, chapters });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const novelSlug = (req.params.novelSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    const chapterSlug = (req.params.chapterSlug || "").replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!novelSlug || !chapterSlug) return res.status(400).json({ ok: false, error: "Invalid" });

    // Try API
    try {
      const data = await apiGet(`${API_BASE}/chapter-content?novelSlug=${novelSlug}&chapterSlug=${chapterSlug}`);
      if (data && data.content) {
        return res.json({ ok: true, title: data.title || chapterSlug, content: data.content, novelSlug,
          prevSlug: data.prev_slug || "", nextSlug: data.next_slug || "" });
      }
    } catch (e) {}

    // Scrape
    const cheerio = require("cheerio");
    const html = await webGet(`${WEB_BASE}/novel-book/${novelSlug}/${chapterSlug}`, 7200);
    const $ = cheerio.load(html);
    const title = $(".chr-title, .chapter-title, h2").first().text().trim();
    $("script, style, .ads, .adsbygoogle, #pop-up, .popup, iframe, noscript, .chapter-nav, .action-bar").remove();

    let content = "";
    for (const sel of ["#chr-content", ".chr-c", ".chapter-content", "#chapterContent", ".content-body", "#vung_doc"]) {
      const el = $(sel).first();
      if (el.length) { content = el.text().trim(); if (content.length > 100) break; }
    }
    if (content.length < 100) {
      const parts = [];
      $("p").each((_, el) => { const t = $(el).text().trim(); if (t.length > 20) parts.push(t); });
      content = parts.join("\n\n");
    }

    const prevHref = $("a#prev_chap, a.chr-prev, a[rel='prev']").attr("href") || "";
    const nextHref = $("a#next_chap, a.chr-next, a[rel='next']").attr("href") || "";

    res.json({ ok: true, title, content, novelSlug,
      prevSlug: prevHref.split("/").filter(Boolean).pop() || "",
      nextSlug: nextHref.split("/").filter(Boolean).pop() || "",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 100);
    if (!q) return res.json({ ok: true, novels: [] });

    try {
      const data = await apiGet(`${API_BASE}/search-novels?keyword=${encodeURIComponent(q)}&limit=20`, 300);
      if (data && (data.data || Array.isArray(data))) {
        const list = data.data || data;
        const novels = list.slice(0, 20).map(n => ({
          title: n.name || n.title || "",
          slug: n.slug || n.id || "",
          cover: n.cover || n.image || "",
        }));
        return res.json({ ok: true, novels });
      }
    } catch (e) {}

    const cheerio = require("cheerio");
    const html = await webGet(`${WEB_BASE}/search?keyword=${encodeURIComponent(q)}`, 300);
    const $ = cheerio.load(html);
    const novels = [];
    $(".list-novel .row, .novel-item, .search-item").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const a = $el.find(".novel-title a, a[href*='novel-book']").first();
      const title = a.text().trim() || a.attr("title") || "";
      const href = a.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.split("/")[0] || href.split("/").filter(Boolean).pop() || "";
      const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
      if (title && slug) novels.push({ title, slug, cover });
    });
    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Latest ────────────────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    try {
      const data = await apiGet(`${API_BASE}/novel-latest?page=1`, 1800);
      if (data && (data.data || Array.isArray(data))) {
        const list = data.data || data;
        const novels = list.slice(0, 20).map(n => ({
          title: n.name || n.title || "",
          slug: n.slug || n.id || "",
          cover: n.cover || n.image || "",
          latestChapter: n.last_chapter || "",
        }));
        return res.json({ ok: true, novels });
      }
    } catch (e) {}

    const cheerio = require("cheerio");
    const html = await webGet(`${WEB_BASE}/latest-release-novel`, 1800);
    const $ = cheerio.load(html);
    const novels = [];
    $(".list-novel .row, .novel-item").each((i, el) => {
      if (i >= 20) return false;
      const $el = $(el);
      const a = $el.find(".novel-title a, a[href*='novel-book']").first();
      const title = a.text().trim();
      const href = a.attr("href") || "";
      const slug = href.split("/novel-book/")[1]?.split("/")[0] || "";
      const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
      const chapter = $el.find(".chr-text, .chapter-text").first().text().trim();
      if (title && slug) novels.push({ title, slug, cover, latestChapter: chapter });
    });
    res.json({ ok: true, novels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use((_, res) => res.status(404).json({ ok: false, error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OneMoreChapter proxy running on port ${PORT}`);
  console.log(`Keep-alive: ${SELF_URL || "disabled"}`);
});
