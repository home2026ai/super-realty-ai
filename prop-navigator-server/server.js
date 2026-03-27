const express = require('express'); 
const cors = require('cors'); 
const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Modality } = require("@google/genai");
require('dotenv').config(); 

// 1. 建立 app (只准出現這一次！)
// --- 順序 1：初始化 app ---
const app = express();
const isAllowedOrigin = (origin) => {
    if (!origin) return true; // allow file:// and same-origin requests
    if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
    if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin)) return true;
    return false;
};
app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true
}));

// --- 順序 2：設定接收上限 (必須在 app.post 之前) ---
// 🌟 這裡沒設好，下面的 API 只要圖大一點就會 413 報錯
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- 順序 3：初始化 AI ---
const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
console.log(`🔑 GEMINI_API_KEY exists: ${hasApiKey}`);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SYSTEM_PROMPT = `
你是房地產專業助理。
允許話題：房地產物件、房地產法規、房地產稅務、房地產租賃、房地產相關資訊。
其他不相關內容不要出現。
使用者提到 A7/A8/A9 時，一律解讀為機捷站點（A7=A7體育大學站、A8長庚醫院站、A9林口站）。
不得提及汽車品牌或車型；若使用者的內容可能被誤解為車款，請引導回房地產需求。
如果使用者有上傳圖片或文件，必須直接分析附件內容；不要回答你無法看圖、無法看附件，除非附件資料真的損壞或無法辨識。
`.trim();
const chatHistoryStore = new Map();
const MAX_HISTORY = 12;
const LISTING_ENDPOINT = "https://www.great-home.com.tw/ajax/dataService.aspx?job=search&path=house";
const LISTING_HTML_BASE = "https://www.great-home.com.tw/buyhouse";
const LISTING_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://www.great-home.com.tw",
    "Referer": "https://www.great-home.com.tw/buyhouse/"
};
const AGENTS_PATH = path.join(__dirname, 'agents.json');
const ANALYTICS_PATH = path.join(__dirname, 'agent-analytics.json');
const YOUTUBE_DATA_API_KEY = process.env.YOUTUBE_DATA_API_KEY || "";
const youtubePlaylistMetaCache = new Map();
const USE_LIST_HTML = false;
const DETAIL_CONCURRENCY = 4;
const CITY_TEMPLATES = {
    taoyuan: ["2", "1", "5", "333", "", "P", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "1", "0"],
    newtaipei: ["2", "1", "4", "244", "", "P", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "1", "0"]
};
const TAOYUAN_A7_TEMPLATE = [
    "2", "1", "5", "333", "", "P", "", "", "", "", "", "", "", "", "", "", "",
    "A7", "", "", "1", "0"
];
const STREET_WHITELIST = {
    a7: [
        "文青路",
        "文青二路",
        "文藝路",
        "文青一路",
        "文學路",
        "文化一路",
        "文樂路",
        "牛角坡路",
        "文吉路",
        "文工一路",
        "文桃路",
        "樂善二路",
        "文華路",
        "文茂路",
        "樂善三路",
        "樂善一路",
        "文化二路",
        "樂學路",
        "樂學二路",
        "華亞三路",
        "樂學三路",
        "樂學一路",
        "長慶一街",
        "長慶二街",
        "長慶三街"
    ]
};

function loadAgents() {
    try {
        const raw = fs.readFileSync(AGENTS_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        console.error("❌ agents load failed:", err);
        return {};
    }
}

function saveAgents(data) {
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeAgent(agent) {
    if (!agent) return null;
    const { password, ...rest } = agent;
    return rest;
}

function loadAnalytics() {
    try {
        const raw = fs.readFileSync(ANALYTICS_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        return { agents: {} };
    }
}

function saveAnalytics(data) {
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function createEmptyAgentAnalytics() {
    return {
        visitors: {
            totalSessions: {},
            dailySessions: {}
        },
        searches: {
            totalCount: 0,
            queries: {}
        },
        browse: {
            items: {}
        }
    };
}

function ensureAgentAnalytics(store, agentId) {
    if (!store.agents || typeof store.agents !== "object") {
        store.agents = {};
    }
    if (!store.agents[agentId]) {
        store.agents[agentId] = createEmptyAgentAnalytics();
    }
    return store.agents[agentId];
}

function getDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getIsoNow() {
    return new Date().toISOString();
}

function getYouTubeMetaCache(playlistId) {
    const cached = youtubePlaylistMetaCache.get(playlistId);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
        youtubePlaylistMetaCache.delete(playlistId);
        return null;
    }
    return cached.payload;
}

function setYouTubeMetaCache(playlistId, payload) {
    youtubePlaylistMetaCache.set(playlistId, {
        payload,
        expiresAt: Date.now() + (1000 * 60 * 20)
    });
}

async function fetchYouTubeJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`youtube api ${resp.status}: ${text || resp.statusText}`);
    }
    return resp.json();
}

async function fetchYouTubePlaylistMeta(playlistId, options = {}) {
    if (!YOUTUBE_DATA_API_KEY) {
        throw new Error("youtube api key missing");
    }
    const forceRefresh = !!options.forceRefresh;
    const cached = forceRefresh ? null : getYouTubeMetaCache(playlistId);
    if (cached) return cached;

    const playlistItems = [];
    let nextPageToken = "";
    do {
        const listUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
        listUrl.searchParams.set("part", "snippet");
        listUrl.searchParams.set("playlistId", playlistId);
        listUrl.searchParams.set("maxResults", "50");
        listUrl.searchParams.set("key", YOUTUBE_DATA_API_KEY);
        if (nextPageToken) listUrl.searchParams.set("pageToken", nextPageToken);
        const listJson = await fetchYouTubeJson(listUrl.toString());
        playlistItems.push(...(Array.isArray(listJson.items) ? listJson.items : []));
        nextPageToken = String(listJson.nextPageToken || "");
    } while (nextPageToken);

    const orderedVideoIds = playlistItems
        .map((item) => item?.snippet?.resourceId?.videoId || "")
        .filter(Boolean);

    const metadataById = new Map();
    for (let i = 0; i < orderedVideoIds.length; i += 50) {
        const chunk = orderedVideoIds.slice(i, i + 50);
        const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
        videosUrl.searchParams.set("part", "snippet,statistics");
        videosUrl.searchParams.set("id", chunk.join(","));
        videosUrl.searchParams.set("key", YOUTUBE_DATA_API_KEY);
        const videosJson = await fetchYouTubeJson(videosUrl.toString());
        for (const item of Array.isArray(videosJson.items) ? videosJson.items : []) {
            metadataById.set(item.id, item);
        }
    }

    const payload = {
        playlistId,
        items: orderedVideoIds.map((videoId, index) => {
            const meta = metadataById.get(videoId);
            const snippet = meta?.snippet || {};
            const statistics = meta?.statistics || {};
            return {
                index,
                videoId,
                title: String(snippet.title || "").trim(),
                description: String(snippet.description || "").trim(),
                thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
                viewCount: Number.parseInt(statistics.viewCount, 10) || 0,
                likeCount: Number.parseInt(statistics.likeCount, 10) || 0,
                likeCountVisible: typeof statistics.likeCount !== "undefined"
            };
        }).filter((item) => item.videoId)
    };

    setYouTubeMetaCache(playlistId, payload);
    return payload;
}

function recordVisit(agentId, sessionId) {
    if (!agentId || !sessionId) return;
    const store = loadAnalytics();
    const agentStats = ensureAgentAnalytics(store, agentId);
    const todayKey = getDayKey();
    const now = getIsoNow();
    agentStats.visitors.totalSessions[sessionId] = agentStats.visitors.totalSessions[sessionId] || now;
    if (!agentStats.visitors.dailySessions[todayKey]) {
        agentStats.visitors.dailySessions[todayKey] = {};
    }
    agentStats.visitors.dailySessions[todayKey][sessionId] = agentStats.visitors.dailySessions[todayKey][sessionId] || now;
    saveAnalytics(store);
}

function recordListingSearch(agentId, sessionId, query) {
    const safeQuery = String(query || "").trim();
    if (!agentId || !sessionId || !safeQuery) return;
    const store = loadAnalytics();
    const agentStats = ensureAgentAnalytics(store, agentId);
    agentStats.searches.totalCount += 1;
    agentStats.searches.queries[safeQuery] = (agentStats.searches.queries[safeQuery] || 0) + 1;
    saveAnalytics(store);
}

function recordBrowseAdd(agentId, sessionId, item) {
    if (!agentId || !sessionId || !item || !item.sn) return;
    const store = loadAnalytics();
    const agentStats = ensureAgentAnalytics(store, agentId);
    const items = agentStats.browse && agentStats.browse.items
        ? agentStats.browse.items
        : (agentStats.browse = { items: {} }).items;
    const now = getIsoNow();
    const sn = String(item.sn).trim();
    const title = String(item.title || "").trim() || "未命名物件";
    if (!items[sn]) {
        items[sn] = {
            sn,
            title,
            addCount: 0,
            lastAddedAt: null
        };
    }
    items[sn].title = title;
    items[sn].addCount += 1;
    items[sn].lastAddedAt = now;
    saveAnalytics(store);
}

function getAgentStatsSummary(agentId) {
    const store = loadAnalytics();
    const agentStats = ensureAgentAnalytics(store, agentId);
    const todayKey = getDayKey();
    const todayVisitors = Object.keys(agentStats.visitors.dailySessions[todayKey] || {}).length;
    const totalVisitors = Object.keys(agentStats.visitors.totalSessions || {}).length;
    const totalSearches = agentStats.searches.totalCount || 0;
    const topQueries = Object.entries(agentStats.searches.queries || {})
        .map(([query, count]) => ({ query, count }))
        .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query, 'zh-Hant'))
        .slice(0, 8);
    const browseItems = Object.values((agentStats.browse && agentStats.browse.items) || {})
        .sort((a, b) => {
            if ((b.addCount || 0) !== (a.addCount || 0)) return (b.addCount || 0) - (a.addCount || 0);
            return String(b.lastAddedAt || "").localeCompare(String(a.lastAddedAt || ""));
        });
    return {
        todayVisitors,
        totalVisitors,
        totalSearches,
        topQueries,
        browseItems
    };
}

function parseSearchQuery(text) {
    const raw = (text || "").trim();
    const criteria = {
        cityKey: null,
        cityKeys: null,
        district: null,
        rooms: null,
        maxPrice: null,
        minArea: null,
        maxArea: null,
        requireCar: false,
        startPage: 1,
        streetWhitelistKey: null,
        keywordTag: null
    };

    const cnNumberMap = {
        "一": 1,
        "二": 2,
        "兩": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
        "十": 10
    };

    if (/__LINKOU_GUISHAN__/.test(raw)) {
        criteria.cityKeys = ["newtaipei", "taoyuan"];
    }
    if (/桃園/.test(raw)) criteria.cityKey = "taoyuan";
    if (/新北|林口/.test(raw)) criteria.cityKey = "newtaipei";
    if (/A9/i.test(raw)) {
        criteria.cityKey = "newtaipei";
        criteria.district = "林口區";
    }
    if (/A7|A8/i.test(raw)) {
        criteria.cityKey = "taoyuan";
        criteria.district = "龜山區";
    }
    if (/A7|Ａ７/i.test(raw)) {
        criteria.streetWhitelistKey = "a7";
        criteria.keywordTag = "a7";
    } else if (/A8|Ａ８/i.test(raw)) {
        criteria.streetWhitelistKey = "a8-exclude-a7";
    }

    const districtMatch = raw.match(/([\u4e00-\u9fff]{2,4})(區|市)/);
    if (districtMatch) {
        criteria.district = `${districtMatch[1]}${districtMatch[2]}`;
    } else if (/林口/.test(raw)) {
        criteria.district = "林口";
    }

    // 桃園只限制在龜山區
    if (criteria.cityKey === "taoyuan" && !criteria.district) {
        criteria.district = "龜山區";
    }

    const roomsMatch = raw.match(/(\d+)\s*房/);
    if (roomsMatch) criteria.rooms = parseInt(roomsMatch[1], 10);

    const cnRoomsMatch = raw.match(/([一二兩三四五六七八九十])\s*房/);
    if (!criteria.rooms && cnRoomsMatch) {
        criteria.rooms = cnNumberMap[cnRoomsMatch[1]] || null;
    }

    const priceMatch = raw.match(/(\d+)\s*萬/);
    if (priceMatch) criteria.maxPrice = parseInt(priceMatch[1], 10);

    if (/車位|車/.test(raw) && !/無車/.test(raw)) criteria.requireCar = true;

    const areaRangeMatch = raw.match(/坪數\s*(\d+(?:\.\d+)?)\s*坪?\s*(?:到|~|-|－|—|至)\s*(\d+(?:\.\d+)?)\s*坪?/);
    if (areaRangeMatch) {
        criteria.minArea = parseFloat(areaRangeMatch[1]);
        criteria.maxArea = parseFloat(areaRangeMatch[2]);
    }
    if (criteria.minArea === null && criteria.maxArea === null) {
        const areaToMatch = raw.match(/(\d+(?:\.\d+)?)\s*坪\s*(?:到|~|-|－|—|至)\s*(\d+(?:\.\d+)?)\s*坪/);
        if (areaToMatch) {
            criteria.minArea = parseFloat(areaToMatch[1]);
            criteria.maxArea = parseFloat(areaToMatch[2]);
        }
    }
    if (criteria.minArea === null && criteria.maxArea === null) {
        const minAreaMatch = raw.match(/(?:至少|需要)\s*(\d+(?:\.\d+)?)\s*坪/);
        if (minAreaMatch) criteria.minArea = parseFloat(minAreaMatch[1]);
    }
    if (criteria.minArea === null) {
        const minAreaBySuffix = raw.match(/(\d+(?:\.\d+)?)\s*坪以上/);
        if (minAreaBySuffix) criteria.minArea = parseFloat(minAreaBySuffix[1]);
    }
    if (criteria.minArea === null && criteria.maxArea === null) {
        const areaPrefixMatch = raw.match(/坪數\s*(\d+(?:\.\d+)?)\s*坪/);
        if (areaPrefixMatch) criteria.minArea = parseFloat(areaPrefixMatch[1]);
    }
    const nearKeywords = [];
    if (/近\s*(機捷|機場捷運)/i.test(raw)) nearKeywords.push("機捷");
    if (/[近進]\s*捷運/i.test(raw)) nearKeywords.push("捷運");
    if (/近\s*(學校|國小|國中|高中|大學)/i.test(raw)) nearKeywords.push("學校");
    if (/近\s*公園/i.test(raw)) nearKeywords.push("公園");
    if (/近\s*市場/i.test(raw)) nearKeywords.push("市場");
    if (/近\s*三井/i.test(raw)) nearKeywords.push("三井");
    if (nearKeywords.length) criteria.nearKeywords = Array.from(new Set(nearKeywords));

    const pageMatch = raw.match(/第\s*(\d+)\s*頁/);
    if (pageMatch) criteria.startPage = parseInt(pageMatch[1], 10) || 1;

    return criteria;
}

function buildQ(cityKey, page, criteria = null) {
    let template = CITY_TEMPLATES[cityKey];
    if (cityKey === "taoyuan" && criteria && criteria.keywordTag === "a7") {
        template = TAOYUAN_A7_TEMPLATE;
    }
    if (!template) return null;
    const parts = [...template];
    const pageIndex = Math.max(parts.length - 2, 0);
    parts[pageIndex] = String(page);
    return parts.join("^");
}

function buildListUrl(cityKey, page, criteria) {
    const cityMap = {
        taoyuan: { name: "桃園市", zip: "333" },
        newtaipei: { name: "新北市", zip: "244" }
    };
    const entry = cityMap[cityKey];
    if (!entry) return null;
    const params = new URLSearchParams();
    if (page && page > 1) params.set("pi", String(page));
    if (criteria && criteria.keywordTag === "a7") params.set("kw", "A7");
    const query = params.toString();
    return `${LISTING_HTML_BASE}/${encodeURIComponent(entry.name)}/${entry.zip}${query ? `?${query}` : ""}`;
}

function normalizeImage(url) {
    if (!url) return null;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return `https://www.great-home.com.tw${url}`;
    return url;
}

async function fetchListingPage(cityKey, page, criteria = null) {
    const q = buildQ(cityKey, page, criteria);
    if (!q) return null;
    const rlg = criteria && criteria.keywordTag === "a7" ? "1" : "0";
    const params = new URLSearchParams({ q, rlg });
    const resp = await fetch(LISTING_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            ...LISTING_HEADERS
        },
        body: params.toString()
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Listing fetch failed: ${resp.status} ${text}`);
    }
    return resp.json();
}

async function fetchListingPageHtml(cityKey, page, criteria = null) {
    const url = buildListUrl(cityKey, page, criteria);
    if (!url) return null;
    const resp = await fetch(url, { headers: LISTING_HEADERS });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Listing HTML fetch failed: ${resp.status} ${text}`);
    }
    const html = await resp.text();
    const items = parseListItemsFromHtml(html);
    console.log(`🧭 HTML parsed: ${items.length} items from ${url}`);
    return html;
}

function mapListing(item) {
    return {
        id: item.s,
        title: item.n || "",
        desc: item.g || "",
        price: item.np ? parseInt(item.np, 10) : (item.pp ? parseInt(item.pp, 10) : null),
        rooms: item.p && item.p[0] ? parseInt(item.p[0], 10) : null,
        halls: item.p && item.p[1] ? parseInt(item.p[1], 10) : null,
        baths: item.p && item.p[2] ? parseInt(item.p[2], 10) : null,
        area: item.a || null,
        address: item.x || "",
        type: item.t || "",
        ageYears: item.k || null,
        floor: item.w || "",
        totalFloor: item.z || "",
        parking: item.u ? (item.u === "O" ? "有" : "無") : (/車位/.test(`${item.n || ""} ${item.g || ""}`) ? "有" : "不明"),
        image: normalizeImage((item.i && item.i[0]) || item.pa),
        link: item.s ? `https://www.great-home.com.tw/detail/?sn=${item.s}` : null
    };
}

function stripTags(html) {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function extractListItems(html, className) {
    const re = new RegExp(`<ul[^>]*class="${className}"[^>]*>([\\s\\S]*?)</ul>`, "i");
    const match = html.match(re);
    if (!match) return [];
    const ul = match[1];
    const items = ul.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return items
        .map((li) => stripTags(li))
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

function extractNearbyFeatures(html) {
    const re = /<ul[^>]*class="house__features"[^>]*>([\s\S]*?)<\/ul>/i;
    const match = html.match(re);
    if (!match) return [];
    const ul = match[1];
    const items = ul.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return items.map((li) => {
        const titleMatch = li.match(/features__tit">([^<]*)<\/p>/i);
        const subMatch = li.match(/features__tit02">([^<]*)<\/p>/i);
        const infoMatch = li.match(/features__info">([\s\S]*?)<\/p>/i);
        const title = titleMatch ? titleMatch[1].trim() : "";
        const sub = subMatch ? subMatch[1].trim() : "";
        const info = infoMatch ? stripTags(infoMatch[1]).replace(/\\s+/g, " ").trim() : "";
        if (title && sub && info) return `${title}：${sub}（${info}）`;
        if (title && sub) return `${title}：${sub}`;
        if (title && info) return `${title}（${info}）`;
        if (title) return title;
        return stripTags(li);
    }).filter(Boolean);
}

async function fetchListingDetailData(sn) {
    const url = `https://www.great-home.com.tw/detail/?sn=${encodeURIComponent(sn)}`;
    const resp = await fetch(url, { headers: LISTING_HEADERS });
    if (!resp.ok) {
        throw new Error(`detail fetch failed: ${resp.status}`);
    }
    const html = await resp.text();
    const features = extractListItems(html, "features-other");
    const nearby = extractNearbyFeatures(html);
    const detailPairs = extractDetailPairs(html);
    const detailLines = extractDetailLines(html);
    const infoTable = extractInfoTable(html);
    const details = Array.from(new Set([
        ...infoTable,
        ...detailPairs.map((p) => `${p.label}：${p.value}`),
        ...detailLines
    ].filter(Boolean)));
    return { features, nearby, details };
}

function extractDetailImages(html) {
    const urls = new Set();
    const blockMatch = html.match(/<div[^>]*class="photo__thumbnail-block"[^>]*>([\s\S]*?)<\/div>/i);
    const block = blockMatch ? blockMatch[1] : "";
    if (!block) return [];
    const attrRe = /(?:data-src|src|rel)=["'](\/\/img\.great-home\.com\.tw[^"']+|https?:\/\/img\.great-home\.com\.tw[^"']+)["']/gi;
    let match;
    while ((match = attrRe.exec(block)) !== null) {
        const url = normalizeImage(match[1]);
        if (!/blank\.gif/i.test(url)) urls.add(url);
    }
    return Array.from(urls);
}

function extractDetailPairs(html) {
    const pairs = [];
    const addPair = (label, value) => {
        const cleanLabel = stripTags(label || "").replace(/\s+/g, " ").trim();
        const cleanValue = stripTags(value || "").replace(/\s+/g, " ").trim();
        if (!cleanLabel || !cleanValue) return;
        if (!pairs.find((p) => p.label === cleanLabel)) {
            pairs.push({ label: cleanLabel, value: cleanValue });
        }
    };
    const patterns = [
        /<span[^>]*class="house__info__tit"[^>]*>([^<]*)<\/span>\s*<span[^>]*class="house__info__num"[^>]*>([^<]*)<\/span>/gi,
        /<span[^>]*class="detail__tit"[^>]*>([^<]*)<\/span>\s*<span[^>]*class="detail__num"[^>]*>([^<]*)<\/span>/gi,
        /<span[^>]*class="info__tit"[^>]*>([^<]*)<\/span>\s*<span[^>]*class="info__num"[^>]*>([^<]*)<\/span>/gi
    ];
    patterns.forEach((re) => {
        let m;
        while ((m = re.exec(html)) !== null) {
            addPair(m[1], m[2]);
        }
    });
    return pairs;
}

function extractDetailLines(html) {
    const classes = ["item__info__table", "house__info__list", "house__info__table"];
    const lines = [];
    classes.forEach((cls) => {
        lines.push(...extractListItems(html, cls));
    });
    return Array.from(new Set(lines));
}

function extractInfoTable(html) {
    const match = html.match(/<table[^>]*class="info02__table"[^>]*>([\s\S]*?)<\/table>/i);
    if (!match) return [];
    const rows = match[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    return rows.map((row) => {
        const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (cells.length < 2) return null;
        const label = stripTags(cells[0]).replace(/\s+/g, " ").trim();
        const value = stripTags(cells[1]).replace(/\s+/g, " ").trim();
        if (!label || !value) return null;
        return `${label}：${value}`;
    }).filter(Boolean);
}

function extractTotalPagesFromHtml(html) {
    const patterns = [
        /共\s*(\d+)\s*頁/,
        /data-total=["'](\d+)["']/i,
        /totalPages\s*[:=]\s*(\d+)/i,
        /"a"\s*:\s*(\d+)/i
    ];
    for (const re of patterns) {
        const match = html.match(re);
        if (match) return parseInt(match[1], 10);
    }
    return 0;
}

function extractAddressFromHtml(block) {
    const match = block.match(/(桃園市[^<\s]{2,}|新北市[^<\s]{2,})/);
    return match ? stripTags(match[1]).trim() : "";
}

function parseListItemsFromHtml(html) {
    const items = [];
    const blockStarts = [];
    const startRe = /<div[^>]*class="itemlist-box"[^>]*>/gi;
    let startMatch;
    while ((startMatch = startRe.exec(html)) !== null) {
        blockStarts.push(startMatch.index);
    }
    for (let i = 0; i < blockStarts.length; i += 1) {
        const start = blockStarts[i];
        const next = html.indexOf("button--more__bg", start);
        if (next === -1) continue;
        const block = html.slice(start, next);
        const snMatch = block.match(/\/detail\/\?sn=([^&"]+)/i);
        const titleMatch = block.match(/itemlist__header__tit[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
        const priceMatch = block.match(/<span[^>]*class="hlight\s+color--red"[^>]*>([^<]+)<\/span>/i);
        const infoHeader = block.match(/itemlist__info__header[\s\S]*?<\/div>/i);
        const headerText = infoHeader ? stripTags(infoHeader[0]) : "";
        const roomsMatch = headerText.match(/(\d+)\s*房/);
        const hallsMatch = headerText.match(/(\d+)\s*廳/);
        const bathsMatch = headerText.match(/(\d+)\s*衛/);
        const areaMatch = headerText.match(/(\d+(?:\.\d+)?)\s*坪/);
        const addressMatch = block.match(/<li>([^<]*市[^<]*區[^<]*)/);
        const ageMatch = block.match(/(\d+(?:\.\d+)?)\s*年/);
        const floorMatch = block.match(/(\d+)\s*\/\s*(\d+)\s*樓/);
        const featuresMatch = block.match(/<ul[^>]*class="itemlist__features"[^>]*>([\s\S]*?)<\/ul>/i);
        const introMatch = block.match(/<p[^>]*class="itemlist__intro"[^>]*>([\s\S]*?)<\/p>/i);
        const features = featuresMatch ? extractListItems(featuresMatch[0], "itemlist__features") : [];
        const intro = introMatch ? stripTags(introMatch[1]).trim() : "";
        const desc = [intro, ...features].filter(Boolean).join(" ");
        const imgMatch = block.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/[^\d]/g, ""), 10) : null;
        const sn = snMatch ? snMatch[1] : "";
        items.push({
            id: sn,
            title: titleMatch ? stripTags(titleMatch[1]) : "",
            desc,
            price: Number.isFinite(price) ? price : null,
            rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : null,
            halls: hallsMatch ? parseInt(hallsMatch[1], 10) : null,
            baths: bathsMatch ? parseInt(bathsMatch[1], 10) : null,
            area: areaMatch ? areaMatch[1] : null,
            address: addressMatch ? stripTags(addressMatch[1]).trim() : extractAddressFromHtml(block),
            ageYears: ageMatch ? ageMatch[1] : null,
            floor: floorMatch ? floorMatch[1] : "",
            totalFloor: floorMatch ? floorMatch[2] : "",
            parking: /車位/.test(block) ? "有" : "不明",
            image: normalizeImage(imgMatch ? imgMatch[1] : null),
            link: sn ? `https://www.great-home.com.tw/detail/?sn=${sn}` : null
        });
    }
    return items;
}

function parseAreaValue(area) {
    if (area === null || area === undefined) return null;
    const num = parseFloat(String(area).replace(/[^\d.]/g, ""));
    return Number.isFinite(num) ? num : null;
}

function matchesNearKeywords(text, keywords) {
    if (!keywords || !keywords.length) return true;
    const rules = {
        "捷運": /捷運/,
        "機捷": /機捷|機場捷運|捷運/,
        "學校": /學校|國小|國中|高中|大學/,
        "公園": /公園/,
        "市場": /市場/,
        "三井": /三井/
    };
    return keywords.every((key) => {
        const rule = rules[key];
        return rule ? rule.test(text) : text.includes(key);
    });
}

function matchesCriteriaWithDetail(item, criteria, detail) {
    if (!matchesCriteria(item, criteria)) return false;
    if (criteria.nearKeywords && criteria.nearKeywords.length) {
        const detailText = `${(detail?.features || []).join(" ")} ${(detail?.nearby || []).join(" ")} ${(detail?.details || []).join(" ")} ${item.desc || ""}`.trim();
        if (!matchesNearKeywords(detailText, criteria.nearKeywords)) return false;
    }
    return true;
}

async function runWithConcurrency(items, limit, handler) {
    let idx = 0;
    const workers = new Array(Math.max(limit, 1)).fill(null).map(async () => {
        while (idx < items.length) {
            const current = items[idx];
            idx += 1;
            await handler(current);
        }
    });
    await Promise.all(workers);
}

function matchesRoomsByText(item, rooms) {
    if (rooms === null || rooms === undefined) return true;
    const hay = `${item.title || ""} ${item.desc || ""}`;
    const re = new RegExp(`${rooms}\\s*房`);
    return re.test(hay);
}

function matchesCriteria(item, criteria) {
    if (criteria.district && item.address && !item.address.includes(criteria.district)) return false;
    if (criteria.rooms !== null) {
        if (item.rooms !== null && item.rooms !== undefined && item.rooms !== criteria.rooms) {
            if (!matchesRoomsByText(item, criteria.rooms)) return false;
        }
    }
    if (criteria.maxPrice !== null) {
        if (item.price && item.price > criteria.maxPrice) return false;
    }
    if (criteria.minArea !== null || criteria.maxArea !== null) {
        const areaVal = parseAreaValue(item.area);
        if (areaVal === null) return false;
        if (criteria.minArea !== null && areaVal < criteria.minArea) return false;
        if (criteria.maxArea !== null && areaVal > criteria.maxArea) return false;
    }
    if (criteria.requireCar) {
        const hay = `${item.title} ${item.desc}`;
        if (!/車/.test(hay)) return false;
    }
    return true;
}

function matchesStreetWhitelist(item, criteria) {
    if (!criteria || !criteria.streetWhitelistKey) return true;
    if (criteria.keywordTag === "a7") return true;
    const hay = `${item.address || ""} ${item.title || ""} ${item.desc || ""}`;
    if (criteria.streetWhitelistKey === "a8-exclude-a7") {
        const list = STREET_WHITELIST.a7 || [];
        if (!list.length) return true;
        return !list.some((street) => hay.includes(street));
    }
    const list = STREET_WHITELIST[criteria.streetWhitelistKey] || [];
    if (!list.length) return true;
    return list.some((street) => hay.includes(street));
}

function matchesKeywordTag(item, criteria) {
    if (!criteria || !criteria.keywordTag) return true;
    const hay = `${item.address || ""} ${item.title || ""} ${item.desc || ""}`;
    if (criteria.keywordTag === "a7") {
        return true;
    }
    return true;
}

function getHistory(sessionId) {
    if (!sessionId) return [];
    if (!chatHistoryStore.has(sessionId)) {
        chatHistoryStore.set(sessionId, []);
    }
    return chatHistoryStore.get(sessionId);
}

function pushHistory(sessionId, role, parts) {
    if (!sessionId) return;
    const history = getHistory(sessionId);
    history.push({ role, parts });
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }
}

function extractResponseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
        return response.text() || "";
    }
    if (typeof response.text === "string") {
        return response.text;
    }
    const candidateText = (response.candidates || [])
        .flatMap((cand) => cand?.content?.parts || [])
        .filter((part) => typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
    return candidateText;
}

async function generateGeminiContent(model, contents, config = undefined) {
    return genAI.models.generateContent({
        model,
        contents,
        ...(config ? { config } : {})
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error) {
    const status = error?.status || error?.response?.status || error?.cause?.status || null;
    const text = JSON.stringify(getErrorDetails(error) || {}).toLowerCase();
    return status === 429 || status === 500 || status === 503 ||
        text.includes("unavailable") ||
        text.includes("high demand") ||
        text.includes("temporarily") ||
        text.includes("overloaded") ||
        text.includes("rate limit");
}

async function generateGeminiContentWithRetry(model, contents, config = undefined, retries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await generateGeminiContent(model, contents, config);
        } catch (error) {
            lastError = error;
            if (!isRetryableGeminiError(error) || attempt === retries) {
                throw error;
            }
            const waitMs = 900 * (attempt + 1);
            console.warn(`⏳ Retry ${attempt + 1}/${retries} for ${model} after ${waitMs}ms`);
            await delay(waitMs);
        }
    }
    throw lastError;
}

function getErrorDetails(error) {
    return {
        status: error?.status || error?.response?.status || error?.cause?.status || null,
        message: error?.message || null,
        responseBody:
            error?.response?.data ||
            error?.response?.body ||
            error?.response ||
            error?.error ||
            error?.cause ||
            null
    };
}

app.post('/api/agents/login', (req, res) => {
    const { agentId, password } = req.body || {};
    if (!agentId || !password) {
        res.status(400).json({ error: "missing credentials" });
        return;
    }
    const agents = loadAgents();
    const agent = agents[agentId];
    if (!agent || agent.password !== password) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    res.json({ agentId, agent: sanitizeAgent(agent) });
});

app.post('/api/analytics/visit', (req, res) => {
    const { agentId, sessionId } = req.body || {};
    if (!agentId || !sessionId) {
        res.status(400).json({ error: "missing analytics payload" });
        return;
    }
    recordVisit(String(agentId), String(sessionId));
    res.json({ ok: true });
});

app.post('/api/analytics/listing-search', (req, res) => {
    const { agentId, sessionId, query } = req.body || {};
    if (!agentId || !sessionId || !query) {
        res.status(400).json({ error: "missing analytics payload" });
        return;
    }
    recordListingSearch(String(agentId), String(sessionId), String(query));
    res.json({ ok: true });
});

app.post('/api/analytics/browse-add', (req, res) => {
    const { agentId, sessionId, item } = req.body || {};
    if (!agentId || !sessionId || !item || !item.sn) {
        res.status(400).json({ error: "missing analytics payload" });
        return;
    }
    recordBrowseAdd(String(agentId), String(sessionId), item);
    res.json({ ok: true });
});

app.get('/api/agents/:agentId', (req, res) => {
    const agentId = req.params.agentId;
    const agents = loadAgents();
    const agent = agents[agentId];
    if (!agent) {
        res.status(404).json({ error: "agent not found" });
        return;
    }
    res.json({ agentId, agent: sanitizeAgent(agent) });
});

app.get('/api/agents/:agentId/stats', (req, res) => {
    const agentId = req.params.agentId;
    const password = typeof req.query.password === "string" ? req.query.password : "";
    if (!password) {
        res.status(400).json({ error: "missing password" });
        return;
    }
    const agents = loadAgents();
    const agent = agents[agentId];
    if (!agent || agent.password !== password) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    res.json({
        agentId,
        stats: getAgentStatsSummary(agentId)
    });
});

app.get('/api/youtube-playlist-meta', async (req, res) => {
    const playlistId = typeof req.query.playlistId === "string" ? req.query.playlistId.trim() : "";
    const forceRefresh = req.query.refresh === "1";
    if (!playlistId) {
        res.status(400).json({ error: "missing playlistId" });
        return;
    }
    if (!YOUTUBE_DATA_API_KEY) {
        res.status(500).json({ error: "youtube api key missing" });
        return;
    }
    try {
        const payload = await fetchYouTubePlaylistMeta(playlistId, { forceRefresh });
        res.json(payload);
    } catch (error) {
        console.error("❌ youtube playlist meta error:", error);
        res.status(502).json({ error: error.message || "youtube meta fetch failed" });
    }
});

app.post('/api/agents/:agentId', (req, res) => {
    const agentId = req.params.agentId;
    const { password, data } = req.body || {};
    if (!password || !data) {
        res.status(400).json({ error: "missing data" });
        return;
    }
    const agents = loadAgents();
    const agent = agents[agentId];
    if (!agent || agent.password !== password) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    const next = {
        ...agent,
        name: typeof data.name === "string" ? data.name : agent.name,
        bio: typeof data.bio === "string" ? data.bio : agent.bio,
        photoUrl: typeof data.photoUrl === "string" ? data.photoUrl : agent.photoUrl,
        lineUrl: typeof data.lineUrl === "string" ? data.lineUrl : agent.lineUrl,
        phoneNumber: typeof data.phoneNumber === "string" ? data.phoneNumber : agent.phoneNumber,
        featuredUrl: typeof data.featuredUrl === "string" ? data.featuredUrl : agent.featuredUrl,
        mediaTitle: typeof data.mediaTitle === "string" ? data.mediaTitle : agent.mediaTitle,
        mediaUrl: typeof data.mediaUrl === "string" ? data.mediaUrl : agent.mediaUrl,
        mediaPlaylistTour: typeof data.mediaPlaylistTour === "string" ? data.mediaPlaylistTour : agent.mediaPlaylistTour,
        mediaPlaylistKnowledge: typeof data.mediaPlaylistKnowledge === "string" ? data.mediaPlaylistKnowledge : agent.mediaPlaylistKnowledge
    };
    agents[agentId] = next;
    saveAgents(agents);
    res.json({ agentId, agent: sanitizeAgent(next) });
});

app.get('/api/listing-detail', async (req, res) => {
    const sn = typeof req.query.sn === "string" ? req.query.sn : "";
    if (!sn) {
        res.status(400).json({ error: "missing sn" });
        return;
    }
    try {
        const url = `https://www.great-home.com.tw/detail/?sn=${encodeURIComponent(sn)}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            res.status(502).json({ error: `detail fetch failed: ${resp.status}` });
            return;
        }
        const html = await resp.text();
        const features = extractListItems(html, "features-other");
        const nearby = extractNearbyFeatures(html);
        const images = extractDetailImages(html);
        const detailPairs = extractDetailPairs(html);
        const detailLines = extractDetailLines(html);
        const infoTable = extractInfoTable(html);
        const details = Array.from(new Set([
            ...infoTable,
            ...detailPairs.map((p) => `${p.label}：${p.value}`),
            ...detailLines
        ].filter(Boolean)));
        res.json({ features, nearby, images, details });
    } catch (err) {
        console.error("❌ listing detail error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/listings-stream', async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const criteria = parseSearchQuery(query);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (event, payload) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const cityKeys = (criteria.cityKeys && criteria.cityKeys.length)
        ? criteria.cityKeys
        : (criteria.cityKey ? [criteria.cityKey] : []);
    if (!cityKeys.length) {
        sendEvent("needCity", { text: "請指定城市（例如：桃園/新北）。", needCity: true });
        res.end();
        return;
    }

    let aborted = false;
    req.on("close", () => {
        aborted = true;
    });

    try {
        let pagesFetched = 0;
        let totalPages = 0;
        const firstPages = [];
        const needsDetail = criteria && Array.isArray(criteria.nearKeywords) && criteria.nearKeywords.length > 0;

        for (const key of cityKeys) {
            let firstPage = null;
            let cityTotal = 0;
            if (USE_LIST_HTML) {
                const html = await fetchListingPageHtml(key, criteria.startPage, criteria);
                firstPage = { html };
                cityTotal = extractTotalPagesFromHtml(html) || criteria.startPage;
            } else {
                const jsonPage = await fetchListingPage(key, criteria.startPage, criteria);
                firstPage = { json: jsonPage };
                cityTotal = jsonPage && jsonPage.a ? parseInt(jsonPage.a, 10) : criteria.startPage;
            }
            totalPages += cityTotal;
            pagesFetched += 1;
            firstPages.push({ key, firstPage, cityTotal });
        }

        sendEvent("info", { pagesFetched, totalPages, criteria: { ...criteria, cityKeys, serverFiltered: needsDetail } });

        for (const entry of firstPages) {
            let firstItems = [];
            if (USE_LIST_HTML) {
                firstItems = parseListItemsFromHtml(entry.firstPage.html || "");
            } else {
                firstItems = (entry.firstPage.json && entry.firstPage.json.data) ? entry.firstPage.json.data.map(mapListing) : [];
            }
            if (!needsDetail) {
                for (const item of firstItems) {
                    if (matchesStreetWhitelist(item, criteria) && matchesKeywordTag(item, criteria)) {
                        sendEvent("item", item);
                    }
                }
            } else {
                await runWithConcurrency(firstItems, DETAIL_CONCURRENCY, async (item) => {
                    if (!matchesStreetWhitelist(item, criteria) || !matchesKeywordTag(item, criteria)) return;
                    let detail = null;
                    try {
                        detail = await fetchListingDetailData(item.id);
                    } catch (e) {
                        return;
                    }
                    if (matchesCriteriaWithDetail(item, criteria, detail)) {
                        sendEvent("item", item);
                    }
                });
            }
        }

        for (const entry of firstPages) {
            for (let p = criteria.startPage + 1; p <= entry.cityTotal; p += 1) {
                if (aborted) break;
                let items = [];
                if (USE_LIST_HTML) {
                    const html = await fetchListingPageHtml(entry.key, p, criteria);
                    items = parseListItemsFromHtml(html || "");
                } else {
                    const data = await fetchListingPage(entry.key, p, criteria);
                    items = (data && data.data) ? data.data.map(mapListing) : [];
                }
                pagesFetched += 1;
                if (!needsDetail) {
                    for (const item of items) {
                        if (matchesStreetWhitelist(item, criteria) && matchesKeywordTag(item, criteria)) {
                            sendEvent("item", item);
                        }
                    }
                } else {
                    await runWithConcurrency(items, DETAIL_CONCURRENCY, async (item) => {
                        if (!matchesStreetWhitelist(item, criteria) || !matchesKeywordTag(item, criteria)) return;
                        let detail = null;
                        try {
                            detail = await fetchListingDetailData(item.id);
                        } catch (e) {
                            return;
                        }
                        if (matchesCriteriaWithDetail(item, criteria, detail)) {
                            sendEvent("item", item);
                        }
                    });
                }
                sendEvent("progress", { pagesFetched, totalPages });
            }
        }

        sendEvent("done", { pagesFetched, totalPages, criteria });
    } catch (error) {
        console.error("❌ Listing Stream API 錯誤詳情:", error);
        sendEvent("error", { text: "物件搜尋失敗：" + error.message });
    }

    res.end();
});

async function logAvailableModels() {
    if (!hasApiKey) {
        console.warn("⚠️ GEMINI_API_KEY missing, skip listing models.");
        return;
    }
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok) {
            console.error("❌ ListModels error:", {
                status: resp.status,
                statusText: resp.statusText,
                body: data
            });
            return;
        }
        const models = data.models || [];
        console.log("📚 Available models:");
        models.forEach((m) => {
            const methods = (m.supportedGenerationMethods || []).join(", ");
            const label = methods ? `${m.name} [${methods}]` : m.name;
            console.log(`- ${label}`);
        });
    } catch (error) {
        console.error("❌ ListModels error:", error);
    }
}

logAvailableModels();

// --- 順序 4：API 路由開始 ---
app.post('/api/listing-intent', async (req, res) => {
    try {
        const { message } = req.body || {};
        const rawMessage = String(message || "").trim();
        if (!rawMessage) {
            res.status(400).json({ error: "message required" });
            return;
        }

        const prompt = `
你是房地產找房意圖判斷器。請判斷使用者這句話是否「可能是在找房」。

重要規則：
1. 只回傳 JSON，不要回傳任何額外文字。
2. 若使用者輸入像 1600、2000 這種未標示單位的數字，且上下文像找房需求，預設視為總價「萬元」。
3. 若提到林口，region 回傳 "linkou"。
4. 若提到龜山但沒明確 A7/A8，region 回傳 "guishan"。
5. 若提到 A7，region 回傳 "a7"；提到 A8，region 回傳 "a8"。
6. 若看起來在找房但完全沒提區域，region 回傳 "unknown"。
7. 若不是找房需求，isListing 回傳 false，其他欄位盡量填 null 或 "none"。

請使用這個 JSON 格式：
{
  "isListing": true,
  "region": "linkou|guishan|a7|a8|unknown|none",
  "rooms": 2,
  "budgetMaxWan": 1600,
  "minAreaPing": null,
  "maxAreaPing": null
}

使用者輸入：
${rawMessage}
        `.trim();

        const response = await generateGeminiContentWithRetry(
            "gemini-2.5-flash",
            [{ role: 'user', parts: [{ text: prompt }] }],
            { responseMimeType: "application/json" }
        );
        const text = extractResponseText(response).trim();
        const jsonText = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
        const parsed = JSON.parse(jsonText);
        const normalized = {
            isListing: Boolean(parsed?.isListing),
            region: String(parsed?.region || "none").toLowerCase(),
            rooms: Number.isFinite(Number(parsed?.rooms)) ? Number(parsed.rooms) : null,
            budgetMaxWan: Number.isFinite(Number(parsed?.budgetMaxWan)) ? Number(parsed.budgetMaxWan) : null,
            minAreaPing: Number.isFinite(Number(parsed?.minAreaPing)) ? Number(parsed.minAreaPing) : null,
            maxAreaPing: Number.isFinite(Number(parsed?.maxAreaPing)) ? Number(parsed.maxAreaPing) : null
        };
        res.json(normalized);
    } catch (error) {
        console.error("❌ listing-intent error:", getErrorDetails(error));
        res.status(500).json({ error: "listing-intent failed" });
    }
});

app.post('/api/chat', async (req, res) => {
    // ... 處理邏輯 ...
    try {
        const { message, imageData, attachmentData, attachmentMimeType, attachmentName, sessionId } = req.body;
        const inlineData = attachmentData || imageData || null;
        const inlineMimeType = attachmentMimeType || (imageData ? "image/jpeg" : null);
        const messageLength = message ? message.length : 0;
        const imageLength = inlineData ? inlineData.length : 0;

        // 🌟 關鍵修正：確保 parts 裡面的每一個元素都是物件格式
        // server.js 第 27 行開始
let promptParts = [];

if (inlineData && inlineMimeType) {
    // 🌟 確保這一塊被正確 push 進去
    promptParts.push({
        inlineData: {
            data: inlineData,
            mimeType: inlineMimeType
        }
    });
}

// 🌟 文字必須放在陣列的最後
const attachmentHint = attachmentName ? `\n附件名稱：${attachmentName}` : "";
const attachmentInstruction = inlineMimeType
    ? /^image\//i.test(inlineMimeType)
        ? `\n這次請直接分析使用者上傳的圖片內容，若是截圖請辨識畫面中的文字與重點。`
        : `\n這次請直接分析使用者上傳的文件內容，先摘要再回答問題。`
    : "";
const combinedText = `${SYSTEM_PROMPT}\n\n${message}${attachmentHint}${attachmentInstruction}`;
promptParts.push({ text: combinedText });

        const history = getHistory(sessionId);
        const contents = [...history, { role: 'user', parts: promptParts }];

        console.log(`📩 message length: ${messageLength}, attachment length: ${imageLength}, mime: ${inlineMimeType || "none"}`);

        const modelNames = inlineMimeType && /^image\//i.test(inlineMimeType)
            ? [
                "gemini-2.5-flash-image",
                "gemini-2.5-flash-image-preview",
                "gemini-2.5-flash"
            ]
            : [
                "gemini-2.5-flash",
                "gemini-2.0-flash",
                "gemini-1.5-flash"
            ];

        let usedModel = null;
        let responseText = null;
        let lastError = null;

        for (const modelName of modelNames) {
            try {
                const response = await generateGeminiContentWithRetry(modelName, contents);
                responseText = extractResponseText(response);
                usedModel = modelName;
                break;
            } catch (error) {
                lastError = error;
                console.warn(`⚠️ Model failed: ${modelName}`);
            }
        }

        if (!responseText) {
            console.error("❌ API 錯誤詳情:", getErrorDetails(lastError));
            throw lastError || new Error("All models failed");
        }

        console.log(`✅ Using model: ${usedModel}`);
        pushHistory(sessionId, 'user', promptParts);
        pushHistory(sessionId, 'model', [{ text: responseText }]);
        res.json({ text: responseText });

    } catch (error) {
        console.error("❌ API 錯誤詳情:", error); // 這行能幫我們在黑窗抓出連線失敗的原因
        const details = getErrorDetails(error);
        const status = details.status || 500;
        const isBusy = isRetryableGeminiError(error);
        res.status(status).json({
            text: isBusy
                ? "圖片分析服務目前流量較高，請稍後再試一次。"
                : `分析失敗：${details.message || "未知錯誤"}`
        });
    }
});

app.post('/api/listings', async (req, res) => {
    try {
        const { query } = req.body;
        const criteria = parseSearchQuery(query);
        const cityKeys = (criteria.cityKeys && criteria.cityKeys.length)
            ? criteria.cityKeys
            : (criteria.cityKey ? [criteria.cityKey] : []);
        if (!cityKeys.length) {
            return res.status(400).json({
                text: "請指定城市（例如：桃園/新北）。",
                needCity: true
            });
        }

        const results = [];
        let pagesFetched = 0;

        let totalPages = 0;
        const firstPages = [];
        const needsDetail = criteria && Array.isArray(criteria.nearKeywords) && criteria.nearKeywords.length > 0;
        for (const key of cityKeys) {
            let firstPage = null;
            let cityTotal = 0;
            if (USE_LIST_HTML) {
                const html = await fetchListingPageHtml(key, criteria.startPage, criteria);
                firstPage = { html };
                cityTotal = extractTotalPagesFromHtml(html) || criteria.startPage;
            } else {
                const jsonPage = await fetchListingPage(key, criteria.startPage, criteria);
                firstPage = { json: jsonPage };
                cityTotal = jsonPage && jsonPage.a ? parseInt(jsonPage.a, 10) : criteria.startPage;
            }
            pagesFetched += 1;
            totalPages += cityTotal;
            firstPages.push({ key, firstPage, cityTotal });
        }

        for (const entry of firstPages) {
            let firstItems = [];
            if (USE_LIST_HTML) {
                firstItems = parseListItemsFromHtml(entry.firstPage.html || "");
            } else {
                firstItems = (entry.firstPage.json && entry.firstPage.json.data) ? entry.firstPage.json.data.map(mapListing) : [];
            }
            if (!needsDetail) {
                for (const item of firstItems) {
                    if (matchesCriteria(item, criteria) && matchesStreetWhitelist(item, criteria) && matchesKeywordTag(item, criteria)) {
                        results.push(item);
                    }
                }
            } else {
                await runWithConcurrency(firstItems, DETAIL_CONCURRENCY, async (item) => {
                    if (!matchesStreetWhitelist(item, criteria) || !matchesKeywordTag(item, criteria)) return;
                    let detail = null;
                    try {
                        detail = await fetchListingDetailData(item.id);
                    } catch (e) {
                        return;
                    }
                    if (matchesCriteriaWithDetail(item, criteria, detail)) {
                        results.push(item);
                    }
                });
            }
        }

        for (const entry of firstPages) {
            for (let p = criteria.startPage + 1; p <= entry.cityTotal; p += 1) {
                let items = [];
                if (USE_LIST_HTML) {
                    const html = await fetchListingPageHtml(entry.key, p, criteria);
                    items = parseListItemsFromHtml(html || "");
                } else {
                    const data = await fetchListingPage(entry.key, p, criteria);
                    items = (data && data.data) ? data.data.map(mapListing) : [];
                }
                pagesFetched += 1;
                if (!needsDetail) {
                    for (const item of items) {
                        if (matchesCriteria(item, criteria) && matchesStreetWhitelist(item, criteria) && matchesKeywordTag(item, criteria)) {
                            results.push(item);
                        }
                    }
                } else {
                    await runWithConcurrency(items, DETAIL_CONCURRENCY, async (item) => {
                        if (!matchesStreetWhitelist(item, criteria) || !matchesKeywordTag(item, criteria)) return;
                        let detail = null;
                        try {
                            detail = await fetchListingDetailData(item.id);
                        } catch (e) {
                            return;
                        }
                        if (matchesCriteriaWithDetail(item, criteria, detail)) {
                            results.push(item);
                        }
                    });
                }
            }
        }

        res.json({
            results,
            info: {
                pagesFetched,
                criteria
            }
        });
    } catch (error) {
        console.error("❌ Listing API 錯誤詳情:", error);
        res.status(500).json({ text: "物件搜尋失敗：" + error.message });
    }
});

app.post('/api/design', async (req, res) => {
    try {
        const { style, imageData } = req.body;
        if (!imageData) {
            return res.status(400).json({ text: "請先上傳照片再進行房屋變裝。" });
        }

        const prompt = `請在不改變原始格局與結構的前提下，將此室內空間改為「${style || "現代風格"}」並產出裝修後的圖片。`;
        const promptParts = [
            {
                inlineData: {
                    data: imageData,
                    mimeType: "image/jpeg"
                }
            },
            { text: prompt }
        ];

        const modelNames = [
            "gemini-2.5-flash-image",
            "gemini-2.5-flash-image-preview",
            "gemini-2.0-flash-exp-image-generation",
            "gemini-2.5-flash"
        ];

        let usedModel = null;
        let lastError = null;
        let lastText = null;

        for (const modelName of modelNames) {
            try {
                const response = await generateGeminiContent(
                    modelName,
                    [{ role: 'user', parts: promptParts }],
                    { responseModalities: [Modality.TEXT, Modality.IMAGE] }
                );
                usedModel = modelName;

                const candidates = response.candidates || [];
                let imagePart = null;
                for (const cand of candidates) {
                    const parts = cand?.content?.parts || [];
                    for (const part of parts) {
                        if (part?.inlineData?.data && part?.inlineData?.mimeType?.startsWith("image/")) {
                            imagePart = part.inlineData;
                            break;
                        }
                    }
                    if (imagePart) break;
                }

                if (imagePart) {
                    console.log(`✅ Design image generated by: ${usedModel}`);
                    return res.json({
                        image: imagePart.data,
                        mimeType: imagePart.mimeType || "image/png"
                    });
                }

                lastText = extractResponseText(response);
                console.warn(`⚠️ Model returned no image: ${modelName}`);
            } catch (error) {
                lastError = error;
                console.warn(`⚠️ Model failed: ${modelName}`);
            }
        }

        console.error("❌ Design API 錯誤詳情:", getErrorDetails(lastError));
        res.status(500).json({ text: lastText || "房屋變裝失敗，請稍後再試。" });
    } catch (error) {
        console.error("❌ Design API 錯誤詳情:", error);
        res.status(500).json({ text: "房屋變裝失敗：" + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動：http://localhost:${PORT}`);
});
