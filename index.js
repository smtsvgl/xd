"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");

const PORT = Number(process.env.PORT || 7000);
const MAX_RESULTS_PER_SITE = 12;
const TIMEOUT_MS = 12000;

const SOURCES = [
  {
    id: "pornhub",
    name: "Pornhub",
    base: "https://www.pornhub.com",
    search: q =>
      "https://www.pornhub.com/video/search?search=" +
      encodeURIComponent(q),
    isVideo: u => /\/view_video\.php/i.test(u)
  },
  {
    id: "xvideos",
    name: "XVideos",
    base: "https://www.xvideos.com",
    search: q =>
      "https://www.xvideos.com/?k=" + encodeURIComponent(q),
    isVideo: u => /\/video\.[a-z0-9]+/i.test(u)
  },
  {
    id: "xhamster",
    name: "xHamster",
    base: "https://xhamster.com",
    search: q =>
      "https://xhamster.com/search/" +
      encodeURIComponent(q),
    isVideo: u => /\/videos\//i.test(u)
  },
  {
    id: "beeg",
    name: "Beeg",
    base: "https://beeg.com",
    search: q =>
      "https://beeg.com/search?q=" + encodeURIComponent(q),
    isVideo: u => /\/video\/|\/[0-9]{5,}/i.test(u)
  },
  {
    id: "noodlemagazine",
    name: "NoodleMagazine",
    base: "https://noodlemagazine.com",
    search: q =>
      "https://noodlemagazine.com/search?q=" +
      encodeURIComponent(q),
    isVideo: u => /\/(watch|video|view)\//i.test(u)
  },
  {
    id: "sxyprn",
    name: "Sxyprn",
    base: "https://sxyprn.com",
    search: q =>
      "https://sxyprn.com/search?query=" +
      encodeURIComponent(q),
    isVideo: u => /\/(video|watch)\//i.test(u)
  },
  {
    id: "youporn",
    name: "YouPorn",
    base: "https://www.youporn.com",
    search: q =>
      "https://www.youporn.com/search/?query=" +
      encodeURIComponent(q),
    isVideo: u => /\/watch\//i.test(u)
  },
  {
    id: "redtube",
    name: "RedTube",
    base: "https://www.redtube.com",
    search: q =>
      "https://www.redtube.com/?search=" +
      encodeURIComponent(q),
    isVideo: u => /\/[0-9]{5,}/i.test(u)
  }
];

const manifest = {
  id: "community.adult.catalog",
  version: "1.0.0",
  name: "Adult Multi-Source Catalog",
  description:
    "Searches publicly accessible adult video pages across multiple sources.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["adult:"],
  catalogs: [
    {
      type: "movie",
      id: "adult_search",
      name: "Adult Search",
      extra: [
        {
          name: "search",
          isRequired: true
        }
      ]
    }
  ],
  behaviorHints: {
    adult: true,
    configurable: false
  }
};

const builder = new addonBuilder(manifest);
const itemStore = new Map();

function encodeId(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeId(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function makeId(url) {
  return "adult:" + encodeId(url);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function safeUrl(value, base) {
  try {
    const u = new URL(value, base);

    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return null;
    }

    return u.href;
  } catch {
    return null;
  }
}

async function getHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/130.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return await response.text();
}

function extractResults(html, source, searchUrl) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("a[href]").each((_, element) => {
    if (results.length >= MAX_RESULTS_PER_SITE) return;

    const anchor = $(element);
    const href = safeUrl(anchor.attr("href"), source.base);

    if (!href || !href.startsWith(source.base)) return;
    if (!source.isVideo(href)) return;
    if (seen.has(href)) return;

    const image = anchor.find("img").first();
    const title = cleanText(
      anchor.attr("title") ||
      image.attr("alt") ||
      anchor.text()
    );

    if (!title || title.length < 3) return;

    const poster = safeUrl(
      image.attr("data-src") ||
      image.attr("data-original") ||
      image.attr("src") ||
      "",
      source.base
    );

    seen.add(href);

    const item = {
      id: makeId(href),
      type: "movie",
      name: title,
      poster: poster || undefined,
      description: "Kaynak: " + source.name,
      website: href,
      source: source.name
    };

    itemStore.set(item.id, item);
    results.push(item);
  });

  return results;
}

async function searchSource(source, query) {
  const searchUrl = source.search(query);

  try {
    const html = await getHtml(searchUrl);
    return extractResults(html, source, searchUrl);
  } catch (error) {
    console.warn(
      `[${source.name}] Arama başarısız: ${error.message}`
    );
    return [];
  }
}

builder.defineCatalogHandler(async args => {
  const query = cleanText(args.extra && args.extra.search);

  if (!query) {
    return { metas: [] };
  }

  // Bir kaynağın hata vermesi diğer aramaları durdurmaz.
  const groups = await Promise.all(
    SOURCES.map(source => searchSource(source, query))
  );

  const unique = new Map();

  for (const item of groups.flat()) {
    if (!unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }

  return {
    metas: Array.from(unique.values()).slice(0, 60)
  };
});

builder.defineMetaHandler(async args => {
  let item = itemStore.get(args.id);

  // Sunucu yeniden başlamışsa kimlikten URL'yi yeniden oluştur.
  if (!item && args.id.startsWith("adult:")) {
    try {
      const url = decodeId(args.id.slice("adult:".length));
      const parsed = new URL(url);

      const source = SOURCES.find(s => s.base === parsed.origin);

      if (source && source.isVideo(url)) {
        item = {
          id: args.id,
          type: "movie",
          name: "Video - " + source.name,
          description: "Orijinal kaynaktaki video sayfası",
          website: url,
          source: source.name
        };
      }
    } catch {
      item = null;
    }
  }

  if (!item) {
    return { meta: null };
  }

  return {
    meta: {
      id: item.id,
      type: "movie",
      name: item.name,
      poster: item.poster,
      description: item.description,
      website: item.website,
      links: [
        {
          name: "Orijinal kaynağı aç",
          category: "Website",
          url: item.website
        }
      ],
      behaviorHints: {
        defaultVideoId: item.id
      }
    }
  };
});

builder.defineStreamHandler(async args => {
  const item = itemStore.get(args.id);
  let pageUrl = item && item.website;

  if (!pageUrl && args.id.startsWith("adult:")) {
    try {
      pageUrl = decodeId(args.id.slice("adult:".length));
    } catch {
      return { streams: [] };
    }
  }

  if (!pageUrl) return { streams: [] };

  let parsed;

  try {
    parsed = new URL(pageUrl);
  } catch {
    return { streams: [] };
  }

  const source = SOURCES.find(s => s.base === parsed.origin);

  if (!source || !source.isVideo(pageUrl)) {
    return { streams: [] };
  }

  try {
    const html = await getHtml(pageUrl);
    const $ = cheerio.load(html);
    const found = new Set();

    // Yalnızca sayfada açıkça yayımlanan medya URL'lerini alır.
    $("video[src], video source[src], source[src]").each((_, el) => {
      const url = safeUrl($(el).attr("src"), pageUrl);

      if (url && /\.(mp4|m3u8|webm)(\?|$)/i.test(url)) {
        found.add(url);
      }
    });

    $('meta[property="og:video"], meta[property="og:video:url"]').each(
      (_, el) => {
        const url = safeUrl($(el).attr("content"), pageUrl);

        if (url && /\.(mp4|m3u8|webm)(\?|$)/i.test(url)) {
          found.add(url);
        }
      }
    );

    return {
      streams: Array.from(found).slice(0, 3).map(url => ({
        name: source.name,
        title: "Public media URL",
        url
      }))
    };
  } catch (error) {
    console.warn(
      `[${source.name}] Video sayfası okunamadı: ${error.message}`
    );
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`Adult Catalog addon running on port ${PORT}`);
console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
