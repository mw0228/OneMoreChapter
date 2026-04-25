const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
app.use(cors());
app.use(express.json());

// ── Crash guards ──────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => console.error("Uncaught:", err.message));
process.on("unhandledRejection", (r) => console.error("Rejection:", r));

// ── Keep-alive ────────────────────────────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health` : null;
if (SELF_URL) setInterval(() => axios.get(SELF_URL,{timeout:5000}).catch(()=>{}), 4*60*1000);

// ── Config ────────────────────────────────────────────────────────────────────
// Sign up FREE at scraperapi.com — paste your key below
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || "";
const BASE = "https://novelbin.com";

// Wrap any URL through ScraperAPI to bypass Cloudflare
function scraperUrl(url) {
  if (!SCRAPER_KEY) return url; // fallback: try direct if no key
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`;
}

async function fetchPage(url, ttl = 3600) {
  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const fetchUrl = scraperUrl(url);
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(fetchUrl, {
        timeout: 25000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        }
      });
      if (res.status === 200 && res.data) {
        cache.set(cacheKey, res.data, ttl);
        return res.data;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, i * 2000));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastErr?.message}`);
}

function parseNovels($, limit = 30) {
  const novels = [];
  const selectors = [
    ".list-novel .row", ".col-novel-main .list-novel .row",
    ".list.list-novel .row", ".truyen-list .row",
    ".novel-item", "li.novel-item", ".item-novel",
  ];
  for (const sel of selectors) {
    $(sel).each((i, el) => {
      if (i >= limit) return false;
      const $el = $(el);
      const a = $el.find("h3.novel-title a, .novel-title a, a[href*='novel-book']").first();
      const title = a.text().trim() || a.attr("title") || "";
      const href = a.attr("href") || "";
      const slug = href.includes("novel-book")
        ? href.split("/novel-book/")[1]?.split("/")[0] || ""
        : href.split("/").filter(Boolean).pop() || "";
      const cover = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "";
      const chapter = $el.find(".chr-text,.chapter-text,.text-chapter").first().text().trim();
      if (title && slug) novels.push({ title, slug, cover, latestChapter: chapter });
    });
    if (novels.length > 0) break;
  }
  return novels;
}

// ── Rankings ──────────────────────────────────────────────────────────────────
app.get("/api/rankings/:type", async (req, res) => {
  try {
    const type = req.params.type;
    const urls = {
      daily:   `${BASE}/most-popular?time=daily`,
      weekly:  `${BASE}/most-popular?time=weekly`,
      monthly: `${BASE}/most-popular?time=monthly`,
      popular: `${BASE}/most-popular`,
    };
    const html = await fetchPage(urls[type] || urls.popular);
    const $ = cheerio.load(html);
    const novels = parseNovels($, 30).map((n, i) => ({ ...n, rank: i + 1 }));
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
    const $ = cheerio.load(html);
    const title = $("h3.title,.book-name,h1.novel-title,h1").first().text().trim();
    const cover = $(".book-img img,.novel-cover img").first().attr("src") || $(".book-img img").first().attr("data-src") || "";
    const author = $("a[href*='author'],.author a").first().text().trim();
    const description = $(".desc-text,#novel-body,.summary__content,.description").first().text().trim().slice(0,1200);
    const genres = [];
    $("a[href*='genre'],.categories a").each((_,el)=>{ const g=$(el).text().trim(); if(g&&!genres.includes(g)&&genres.length<8) genres.push(g); });
    const chapters = [];
    $(".list-chapter li a,ul.list-chapter a,#list-chapter a").each((i,el)=>{
      if(i>=100) return false;
      const href=$(el).attr("href")||"";
      const chSlug=href.split("/").filter(Boolean).pop()||"";
      const name=$(el).text().trim();
      if(name&&chSlug) chapters.push({index:i,name,slug:chSlug,href});
    });
    res.json({ ok:true, novel:{title,cover,author,status:"Unknown",genres,description,rating:"",chapters,slug} });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chapters paginated ────────────────────────────────────────────────────────
app.get("/api/novel/:slug/chapters", async (req, res) => {
  try {
    const slug = (req.params.slug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    const page = Math.min(Math.max(parseInt(req.query.page)||1,1),200);
    const html = await fetchPage(`${BASE}/novel-book/${slug}?page=${page}`,1800);
    const $ = cheerio.load(html);
    const chapters = [];
    $(".list-chapter li a,ul.list-chapter a,#list-chapter a").each((i,el)=>{
      const href=$(el).attr("href")||"";
      const chSlug=href.split("/").filter(Boolean).pop()||"";
      const name=$(el).text().trim();
      if(name&&chSlug) chapters.push({index:(page-1)*50+i,name,slug:chSlug,href});
    });
    res.json({ ok:true, chapters });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── Read chapter ──────────────────────────────────────────────────────────────
app.get("/api/chapter/:novelSlug/:chapterSlug", async (req, res) => {
  try {
    const novelSlug=(req.params.novelSlug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    const chapterSlug=(req.params.chapterSlug||"").replace(/[^a-zA-Z0-9\-_]/g,"");
    if(!novelSlug||!chapterSlug) return res.status(400).json({ok:false,error:"Invalid"});
    const html = await fetchPage(`${BASE}/novel-book/${novelSlug}/${chapterSlug}`,7200);
    const $ = cheerio.load(html);
    const title = $(".chr-title,.chapter-title,h2").first().text().trim();
    $("script,style,.ads,.adsbygoogle,#pop-up,.popup,iframe,noscript,.chapter-nav,.action-bar").remove();
    let content = "";
    for (const sel of ["#chr-content",".chr-c",".chapter-content","#chapterContent",".content-body","#vung_doc"]) {
      const el=$(sel).first();
      if(el.length){ content=el.text().trim(); if(content.length>100) break; }
    }
    if(content.length<100){
      const parts=[]; $("p").each((_,el)=>{ const t=$(el).text().trim(); if(t.length>20) parts.push(t); });
      content=parts.join("\n\n");
    }
    const prevHref=$("a#prev_chap,a.chr-prev,a[rel='prev']").attr("href")||"";
    const nextHref=$("a#next_chap,a.chr-next,a[rel='next']").attr("href")||"";
    res.json({ ok:true,title,content,novelSlug,
      prevSlug:prevHref.split("/").filter(Boolean).pop()||"",
      nextSlug:nextHref.split("/").filter(Boolean).pop()||"" });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const q=(req.query.q||"").trim().slice(0,100);
    if(!q) return res.json({ok:true,novels:[]});
    const html = await fetchPage(`${BASE}/search?keyword=${encodeURIComponent(q)}`,300);
    const $ = cheerio.load(html);
    const novels = parseNovels($,20);
    res.json({ ok:true, novels });
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

// ── Latest ────────────────────────────────────────────────────────────────────
app.get("/api/latest", async (req, res) => {
  try {
    const html = await fetchPage(`${BASE}/latest-release-novel`,1800);
    const $ = cheerio.load(html);
    const novels = parseNovels($,20);
    res.json({ ok:true, novels });
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_,res) => res.json({ ok:true, uptime:process.uptime(), scraperApi: !!SCRAPER_KEY }));
app.use((_,res) => res.status(404).json({ok:false,error:"Not found"}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`OneMoreChapter proxy on port ${PORT} | ScraperAPI: ${SCRAPER_KEY ? "enabled" : "NO KEY SET"}`));
