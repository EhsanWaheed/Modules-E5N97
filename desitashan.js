// ==========================================
// ⚙️ SORA MODULE — DESI TASHAN
// ==========================================
// desitashan.su is an episode-first site: search returns *episodes*, and a show
// is just a category page. The module maps it like this:
//
//   Search    GET /search.php?s=<text>                 (+ /search/<text>/page/N/)
//             -> <article class="episode-card"> blocks; episodes are grouped
//                into shows by their first category link (/category/<show>/)
//   Show      GET /category/<show>/  (+ /page/N/, 20 episodes a page)
//             -> <article class="card"> blocks: href, "Episode N", date, poster
//   Playback  The episode page only holds buttons that all point at one link:
//     1. GET <episode page>                 -> .../getlink.php?v=<blob>&part2=...
//     2. GET getlink.php                    -> <meta http-equiv="refresh"> target
//        (go.freezod.com/published?...&vt=<10 minute token>), which redirects
//        to a freezod.com page carrying <script id="article-video-settings">.
//     3. settings.state.parts = {part1..partN}: the episode is split into
//        sequential parts (~100-200 MB each).
//     4. GET freezod.com/hls/media_meta.php?v=<part>&embed_url=<page>&type=player
//        -> {source:{file:"play.php?v=..."}}; play.php answers 302 to a signed
//        MP4 on Yandex storage. That host refuses requests that carry the
//        freezod Referer, so the streams are given WITHOUT headers.
//   No cookies are needed anywhere. Every play starts a fresh chain because
//   the tokens expire after about 10 minutes.
//
// Sora cannot join files or autoplay streams, so every part is its own list
// entry ("Ep 30 · Part 1/7"): the app's next-item button then walks through the
// whole episode. The part count is read from the episode page (the link-host
// URL carries part2..partN), costing one cheap request per episode.

const DT_BASE = "https://www.desitashan.su";
const DT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const DT_SEARCH_PAGES = 3;     // search pages read (12 episodes each)
const DT_MAX_LIST_PAGES = 10;  // listing pages read (12-20 episodes each)
const DT_MAX_EPISODES = 120;   // newest episodes listed for a show
const DT_PART_PROBES = 24;     // newest episodes whose part count is read exactly
const DT_PROBE_BATCH = 8;      // episode pages fetched in parallel
const DT_TIMEOUT_MS = 15000;

// Category slugs that are TV channels rather than shows.
const DT_CHANNELS = [
    "star-plus", "colors-tv", "zee-tv", "sony-tv", "sab-tv", "and-tv", "dangal-tv",
    "star-bharat", "sun-neo", "shemaroo-umang", "vijay-television", "star-jalsha",
    "other-content"
];

// ==========================================
// 🌐 NETWORK
// ==========================================

async function soraFetch(url, options = { headers: {}, method: 'GET', body: null }) {
    const headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = DT_UA;
    try {
        if (typeof fetchv2 !== 'undefined') {
            return await fetchv2(url, headers, options.method ?? 'GET', options.body ?? null);
        } else {
            return await fetch(url, { ...options, headers: headers });
        }
    } catch (e) {
        try { return await fetch(url, { ...options, headers: headers }); } catch (error) { return null; }
    }
}

async function readBody(response) {
    if (!response) return "";
    if (typeof response.text === 'function') return await response.text();
    if (typeof response.data === 'string') return response.data;
    return "";
}

function withTimeout(promise, ms) {
    if (typeof setTimeout !== 'function') return promise;
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}

async function getText(url, headers) {
    return await withTimeout(readBody(await soraFetch(url, { method: 'GET', headers: headers || {} })), DT_TIMEOUT_MS) || "";
}

async function dtGet(path) {
    return await getText(path.charAt(0) === '/' ? `${DT_BASE}${path}` : path, {
        "User-Agent": DT_UA, "Accept": "text/html,application/xhtml+xml", "Referer": `${DT_BASE}/`
    });
}

function decodeEntities(text) {
    if (!text) return "";
    return String(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&#039;|&#39;|&rsquo;/g, "'")
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/\s+/g, ' ')
        .trim();
}

function absolute(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return url.charAt(0) === '/' ? `${DT_BASE}${url}` : `${DT_BASE}/${url}`;
}

// ==========================================
// 🧩 PARSING
// ==========================================

// Episode cards come in two flavours: <article class="episode-card"> (search)
// and <article class="card"> (category pages). Both carry the same fields.
function parseCards(html) {
    const cards = [];
    const seen = {};
    const re = /<article class="(?:episode-card|card)[^"]*"[\s\S]*?<\/article>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const block = m[0];
        const href = (block.match(/href="((?:https:\/\/www\.desitashan\.su)?\/[^"]*?\/[0-9a-f]{16}\/)"/) || [])[1];
        if (!href) continue;
        const path = href.replace(DT_BASE, "");
        if (seen[path]) continue;
        seen[path] = true;

        const title = decodeEntities((block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
        const number = parseInt((block.match(/aria-label="Episode (\d+)"/) || [])[1], 10);
        const date = decodeEntities((block.match(/episode-date-card[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
        const image = (block.match(/<img[^>]+src="([^"]+)"/) || [])[1] || "";

        const categories = [];
        const cre = /<a href="\/category\/((?:[^\/"]+\/)*[^\/"]+)\/">([\s\S]*?)<\/a>/g;
        let cm;
        while ((cm = cre.exec(block)) !== null) {
            const segments = cm[1].split('/');
            categories.push({ path: cm[1], slug: segments[segments.length - 1], name: decodeEntities(cm[2]) });
        }

        cards.push({ path: path, title: title, number: isNaN(number) ? null : number, date: date, image: absolute(image), categories: categories });
    }
    return cards;
}

// "Anupama 20th July 2025 Full Episode | Star Plus" -> "Anupama"
function showNameFromTitle(title) {
    const m = String(title).match(/^(.*?)\s+\d{1,2}(?:st|nd|rd|th)\s+[A-Za-z]+\s+\d{4}\b/);
    return m ? m[1].trim() : "";
}

// A show is its own category when it has one; older shows only sit under their
// channel, so those are recognised by the name in the episode title instead.
function showOf(card) {
    for (const c of card.categories) {
        if (DT_CHANNELS.indexOf(c.slug) < 0) return { href: `dt://category/${c.path}`, name: c.name, key: `c:${c.path}` };
    }
    const name = showNameFromTitle(card.title);
    if (name) return { href: `dt://search/${encodeURIComponent(name)}`, name: name, key: `s:${name.toLowerCase()}` };
    return null;
}

// ==========================================
// 🔍 SEARCH
// ==========================================

// href = dt://category/<category path>  or  dt://search/<show name>
async function searchResults(keyword) {
    try {
        const q = encodeURIComponent(keyword);
        const pages = [dtGet(`/search.php?s=${q}`)];
        for (let p = 2; p <= DT_SEARCH_PAGES; p++) pages.push(dtGet(`/search/${q}/page/${p}/`));
        const htmls = await Promise.all(pages);

        const shows = [];
        const index = {};
        for (const html of htmls) {
            for (const card of parseCards(html)) {
                const show = showOf(card);
                if (!show) continue;
                if (index[show.key] === undefined) {
                    index[show.key] = shows.length;
                    shows.push({ title: show.name, image: card.image, href: show.href });
                }
            }
        }
        return JSON.stringify(shows);
    } catch (error) {
        return JSON.stringify([]);
    }
}

// ==========================================
// 📖 DETAILS
// ==========================================

// -> {kind: "category", path} | {kind: "search", name}
function parseShow(url) {
    const rest = String(url).replace('dt://', '').replace(/^\/+|\/+$/g, '');
    if (rest.indexOf('search/') === 0) {
        let name = rest.slice('search/'.length);
        try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
        return { kind: "search", name: name };
    }
    return { kind: "category", path: rest.replace(/^category\//, '') };
}

async function extractDetails(url) {
    const show = parseShow(url);
    try {
        if (show.kind === "search") {
            const html = await dtGet(`/search.php?s=${encodeURIComponent(show.name)}`);
            const latest = parseCards(html).filter(c => showNameFromTitle(c.title).toLowerCase() === show.name.toLowerCase())[0];
            return JSON.stringify([{
                description: `Daily episodes of ${show.name} from Desi Tashan.`,
                aliases: latest ? `Channel: ${latest.categories.map(c => c.name).join(", ")}` : "",
                airdate: latest && latest.date ? `Latest: ${latest.date}` : ""
            }]);
        }
        const html = await dtGet(`/category/${show.path}/`);
        const latest = parseCards(html)[0];
        const channel = latest ? latest.categories.filter(c => c.path !== show.path).map(c => c.name).join(", ") : "";
        const desc = decodeEntities((html.match(/<meta name="description" content="([^"]*)"/) || [])[1]);
        return JSON.stringify([{
            description: desc || "Daily episodes from Desi Tashan.",
            aliases: channel ? `Channel: ${channel}` : "",
            airdate: latest && latest.date ? `Latest: ${latest.date}` : ""
        }]);
    } catch (error) {
        return JSON.stringify([{ description: 'Loading error.', aliases: '', airdate: '' }]);
    }
}

// ==========================================
// 📂 EPISODES
// ==========================================

// Pages of a listing: first page + every /page/N/ the first page links to.
async function listingPages(firstUrl, pageUrl, pageRe) {
    const first = await dtGet(firstUrl);
    let last = 1;
    let pm;
    while ((pm = pageRe.exec(first)) !== null) last = Math.max(last, parseInt(pm[1], 10));
    last = Math.min(last, DT_MAX_LIST_PAGES);
    const rest = [];
    for (let p = 2; p <= last; p++) rest.push(dtGet(pageUrl(p)));
    return [first].concat(await Promise.all(rest));
}

// The link-host URL on an episode page carries v (part 1) plus part2..partN.
function partCount(pageHtml) {
    if (!/getlink\.php\?/.test(pageHtml)) return 0;
    let count = 1;
    const re = /(?:&amp;|&|\?)part(\d+)=/g;
    let m;
    while ((m = re.exec(pageHtml)) !== null) count = Math.max(count, parseInt(m[1], 10));
    return count;
}

function mostCommon(values, fallback) {
    const tally = {};
    let best = fallback, bestCount = 0;
    for (const v of values) {
        tally[v] = (tally[v] || 0) + 1;
        if (tally[v] > bestCount) { bestCount = tally[v]; best = v; }
    }
    return best;
}

// href = dt-play://<episode path>|<part number>
async function extractEpisodes(url) {
    const show = parseShow(url);
    try {
        let htmls, keep = () => true;
        if (show.kind === "search") {
            const q = encodeURIComponent(show.name);
            htmls = await listingPages(`/search.php?s=${q}`, p => `/search/${q}/page/${p}/`, /\/search\/[^"\/]+\/page\/(\d+)\//g);
            keep = card => showNameFromTitle(card.title).toLowerCase() === show.name.toLowerCase();
        } else {
            htmls = await listingPages(`/category/${show.path}/`, p => `/category/${show.path}/page/${p}/`, /\/page\/(\d+)\//g);
        }

        let cards = [];
        const seen = {};
        for (const html of htmls) {
            for (const card of parseCards(html)) {
                if (keep(card) && !seen[card.path]) { seen[card.path] = true; cards.push(card); }
            }
        }
        cards = cards.slice(0, DT_MAX_EPISODES);                    // newest first

        // Exact part counts for the newest episodes; older ones assume the
        // most common count (a show splits its episodes the same way).
        const counts = {};
        const probe = cards.slice(0, DT_PART_PROBES);
        for (let i = 0; i < probe.length; i += DT_PROBE_BATCH) {
            const batch = probe.slice(i, i + DT_PROBE_BATCH);
            const pages = await Promise.all(batch.map(card => dtGet(card.path)));
            batch.forEach((card, j) => { const n = partCount(pages[j]); if (n > 0) counts[card.path] = n; });
        }
        const usual = mostCommon(Object.keys(counts).map(k => counts[k]), 1);

        // Ascending order; every part becomes its own entry.
        cards.reverse();
        const episodes = [];
        let running = 0;
        cards.forEach((card, i) => {
            const episodeNumber = card.number !== null ? card.number : i + 1;
            const parts = counts[card.path] || usual;
            for (let part = 1; part <= parts; part++) {
                running++;
                const label = parts > 1 ? `Ep ${episodeNumber} · Part ${part}/${parts}` : `Ep ${episodeNumber}`;
                episodes.push({
                    href: `dt-play://${card.path}|${part}`,
                    number: running,
                    season: 1,
                    title: card.date ? `${label} · ${card.date}` : label
                });
            }
        });
        return JSON.stringify(episodes);
    } catch (error) {
        return JSON.stringify([]);
    }
}

// ==========================================
// 🍪 MANUAL REDIRECTS (cookie fallback)
// ==========================================
// freezod issues a session cookie on its redirect hop and only shows the video
// page when that cookie comes back. Most HTTP clients carry it through the
// redirect on their own; if not, follow the hops by hand.

function headerOf(response, name) {
    const h = response && response.headers;
    if (!h) return "";
    if (typeof h.get === 'function') return h.get(name) || "";
    for (const key of Object.keys(h)) if (key.toLowerCase() === name) return String(h[key]);
    return "";
}

function setCookiesOf(response) {
    const h = response && response.headers;
    if (!h) return [];
    if (typeof h.getSetCookie === 'function') return h.getSetCookie();
    const raw = headerOf(response, 'set-cookie');
    return raw ? raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/) : [];
}

async function rawFetch(url, headers) {
    try {
        if (typeof fetchv2 !== 'undefined') return await fetchv2(url, headers, 'GET', null, false);
        return await fetch(url, { headers: headers, redirect: 'manual' });
    } catch (e) { return null; }
}

async function followByHand(startUrl, referer) {
    const jar = {};
    let current = startUrl, ref = referer;
    for (let i = 0; i < 6; i++) {
        const headers = { "User-Agent": DT_UA, "Referer": ref };
        const cookie = Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; ');
        if (cookie) headers["Cookie"] = cookie;
        const response = await withTimeout(rawFetch(current, headers), DT_TIMEOUT_MS);
        if (!response) return "";
        for (const c of setCookiesOf(response)) {
            const pair = c.split(';')[0];
            const eq = pair.indexOf('=');
            if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
        const location = headerOf(response, 'location');
        if (location) { ref = current; current = resolveHref(location, current); continue; }
        return await readBody(response);
    }
    return "";
}

function resolveHref(ref, base) {
    if (/^https?:\/\//i.test(ref)) return ref;
    const origin = (base.match(/^https?:\/\/[^\/]+/) || [""])[0];
    if (ref.charAt(0) === '/') return origin + ref;
    return base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + ref;
}

// ==========================================
// 🎬 PLAYBACK
// ==========================================

async function extractStreamUrl(url) {
    const raw = String(url).replace('dt-play://', '');
    const split = raw.lastIndexOf('|');
    const path = split >= 0 ? raw.slice(0, split) : raw;
    const wantedPart = split >= 0 ? parseInt(raw.slice(split + 1), 10) : null;     // null = every part
    const pageUrl = absolute(path);
    try {
        // 1. episode page -> link-host URL
        const page = await dtGet(pageUrl);
        const gm = page.match(/href="(https:\/\/[^"]*getlink\.php\?[^"]+)"/);
        if (!gm) {
            console.log("[Player] DesiTashan: no stream link on the episode page");
            return JSON.stringify({ type: "none" });
        }
        const getlink = decodeEntities(gm[1].replace(/&amp;/g, '&')).replace(/ /g, '+');

        // 2. link host -> meta-refresh target (carries a ~10 minute token)
        const hop = await getText(getlink, { "User-Agent": DT_UA, "Referer": `${DT_BASE}/` });
        const rm = hop.match(/http-equiv="refresh"[^>]*content="[^"]*?url=([^"]+)"/i);
        if (!rm) {
            console.log("[Player] DesiTashan: link host did not redirect");
            return JSON.stringify({ type: "none" });
        }
        const target = rm[1].replace(/&amp;/g, '&');

        // 3. redirect chain -> freezod page holding the parts
        const settingsRe = /<script[^>]*id="article-video-settings"[^>]*>([\s\S]*?)<\/script>/;
        let article = await getText(target, { "User-Agent": DT_UA, "Referer": "https://freezod.searchping.com/" });
        let sm = article.match(settingsRe);
        if (!sm) {
            // The client dropped the session cookie across the redirect; carry it by hand.
            article = await followByHand(target, "https://freezod.searchping.com/");
            sm = article.match(settingsRe);
        }
        if (!sm) {
            console.log("[Player] DesiTashan: video settings not found");
            return JSON.stringify({ type: "none" });
        }
        let settings;
        try { settings = JSON.parse(sm[1]); } catch (e) { settings = null; }
        const parts = settings && settings.state && settings.state.parts ? settings.state.parts : null;
        const articlePath = settings && settings.release && settings.release.path ? settings.release.path : "";
        if (!parts || !articlePath) {
            console.log("[Player] DesiTashan: no parts in the video settings");
            return JSON.stringify({ type: "none" });
        }
        const embedUrl = `https://freezod.com${articlePath}`;
        const allNames = Object.keys(parts).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
        const names = (wantedPart && wantedPart >= 1 && wantedPart <= allNames.length) ? [allNames[wantedPart - 1]] : allNames;
        if (wantedPart && !(wantedPart >= 1 && wantedPart <= allNames.length)) {
            console.log(`[Player] DesiTashan: part ${wantedPart} does not exist (episode has ${allNames.length})`);
            return JSON.stringify({ type: "none" });
        }

        // 4. each part -> media_meta -> play.php (302 to the signed MP4)
        const resolved = await Promise.all(names.map(async (name) => {
            const query = `v=${encodeURIComponent(parts[name])}&embed_url=${encodeURIComponent(embedUrl)}`;
            const text = await getText(`https://freezod.com/hls/media_meta.php?${query}&type=player`, {
                "User-Agent": DT_UA, "Accept": "application/json", "Referer": `https://freezod.com/hls/jwplayer.php?${query}`
            });
            try {
                const file = JSON.parse(text).source.file;
                if (!file) return null;
                return /^https?:\/\//i.test(file) ? file : `https://freezod.com/hls/${file}`;
            } catch (e) { return null; }
        }));

        const streams = [];
        resolved.forEach((link, i) => {
            const number = wantedPart || (i + 1);
            if (link) streams.push({ title: `Part ${number}/${allNames.length}`, streamUrl: link, headers: {} });
        });

        if (streams.length === 0) {
            console.log("[Player] DesiTashan: no playable part");
            return JSON.stringify({ type: "none" });
        }
        return JSON.stringify({
            type: "servers",
            streams: streams,
            subtitles: "",
            subtitlesHeaders: {},
            allSubtitles: []
        });
    } catch (error) {
        console.log(`[Player] DesiTashan error: ${error}`);
        return JSON.stringify({ type: "none" });
    }
}
