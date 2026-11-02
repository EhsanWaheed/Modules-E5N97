// ==========================================
// ⚙️ SORA MODULE — BINGEBANG
// ==========================================
// bingebang.st serves a TMDB-shaped JSON API under /api (verified live):
//
//   Search   GET /api/search/multi?query=<text>
//            -> {results:[{id, media_type: "movie"|"tv", title|name,
//                          poster_path, overview, year, url, play_url}]}
//   Details  GET /api/<movie|tv>/<id>      (tv carries `seasons`)
//   Season   GET /api/tv/<id>/season/<n>   (one search entry per season)
//            -> {episodes:[{episode_number, name, play_url, ...}]}
//            play_url looks like /tv/play/<slug>/<season>/<episode>
//
// Posters are plain TMDB paths: https://image.tmdb.org/t/p/w342<poster_path>
//
// PLAYBACK (reverse-engineered from the site's own player scripts)
//   1. GET /tv/play/<slug>/<season>/<episode>  (or /movie/play/<slug>)
//      The page hides its config in an inline script: a byte array d XORed with
//      a short repeating key k. Decoded, it holds `ticket: "..."`.
//      Visitors it takes for VPN/proxy traffic get a Cloudflare Turnstile page
//      instead; the module then reports "none" rather than a broken link.
//   2. GET /api/player/sources   headers X-BB-Player: 1, X-BB-Ticket: <ticket>
//      -> {enc: "<base64url>"}  decrypting to {ok, servers:[{label, quality, source_url}]}
//   3. GET /api/player/resolve?src=<source_url>   (same headers, same encryption)
//      -> {ok, url, type, qualities, subtitles}
//   Cipher: key = sha256(BB_KEY_PREFIX + ticket); blob = nonce(16) + ciphertext;
//   keystream block i = sha256(key + nonce + uint32_be(i)); plaintext = ct XOR ks.
//   The video hosts only check Referer: https://bingebang.st/.

const BB_BASE = "https://bingebang.st";
const BB_IMG = "https://image.tmdb.org/t/p/w342";
// Constant the site's player prepends to the ticket when deriving the key. If
// playback suddenly fails with "decrypt failed", the site rotated it.
const BB_KEY_PREFIX = "9e2b7c41a0f6d85b3c1e7a94f25d0b86";
const BB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ==========================================
// 🌐 NETWORK
// ==========================================

async function soraFetch(url, options = { headers: {}, method: 'GET', body: null }) {
    const headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = BB_UA;
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

async function bbApi(path) {
    const headers = {
        "User-Agent": BB_UA,
        "Accept": "application/json",
        "Referer": `${BB_BASE}/`
    };
    const body = await readBody(await soraFetch(`${BB_BASE}/api/${path}`, { method: 'GET', headers: headers }));
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
}

// ==========================================
// 🔍 SEARCH
// ==========================================

// href = bb://<movie|tv>/<id>[/<season_number>]
// Multi-season shows are returned as one entry per season, so each season gets
// its own episode list (and the app searches subtitles per season).
async function searchResults(keyword) {
    try {
        const data = await bbApi(`search/multi?query=${encodeURIComponent(keyword)}`);
        const list = data && Array.isArray(data.results) ? data.results : [];
        const items = list.filter(r => (r.media_type === "movie" || r.media_type === "tv")
            && (r.media_type === "tv" ? (r.name || r.original_name) : (r.title || r.original_title)));

        // The search payload only carries a season *count*, which can disagree
        // with the seasons actually on the site (e.g. One Piece), so read the
        // real season list for every multi-season show.
        const details = await Promise.all(items.map(r =>
            r.media_type === "tv" && (r.number_of_seasons || 0) > 1
                ? bbApi(`tv/${r.id}`).catch(() => null)
                : Promise.resolve(null)
        ));

        const results = [];
        items.forEach((r, i) => {
            const title = r.media_type === "tv" ? (r.name || r.original_name) : (r.title || r.original_title);
            const label = r.year ? `${title} (${r.year})` : title;
            const image = r.poster_path ? `${BB_IMG}${r.poster_path}` : "";

            let seasons = [];
            const d = details[i];
            if (d && Array.isArray(d.seasons)) seasons = d.seasons.filter(x => x.season_number > 0);
            if (r.media_type === "tv" && seasons.length > 1) {
                for (const se of seasons) {
                    const n = se.season_number;
                    const name = n < 100 ? `Season ${n}` : (se.name || `Season ${n}`);
                    results.push({ title: `${label} · ${name}`, image: image, href: `bb://tv/${r.id}/${n}` });
                }
            } else {
                results.push({ title: label, image: image, href: `bb://${r.media_type}/${r.id}` });
            }
        });
        return JSON.stringify(results);
    } catch (error) {
        return JSON.stringify([]);
    }
}

// ==========================================
// 📖 DETAILS
// ==========================================

function parseHref(url) {
    const parts = String(url).replace('bb://', '').split('/');
    return { type: parts[0], id: parts[1], season: parts.length > 2 ? parseInt(parts[2], 10) : null };
}

async function extractDetails(url) {
    const ref = parseHref(url);
    try {
        const d = await bbApi(`${ref.type}/${ref.id}`);
        if (!d) throw new Error("no data");

        const genres = Array.isArray(d.genres) ? d.genres.map(g => g.name).join(", ") : "";
        const aliases = [d.original_name || d.original_title, d.tagline, genres]
            .filter(x => x).join(" | ");
        const date = d.first_air_date || d.release_date || "";
        const airdate = [date, d.status].filter(x => x).join(" · ");

        return JSON.stringify([{
            description: d.overview || "No synopsis available.",
            aliases: aliases,
            airdate: airdate
        }]);
    } catch (error) {
        return JSON.stringify([{ description: 'Loading error.', aliases: '', airdate: '' }]);
    }
}

// ==========================================
// 📂 EPISODES
// ==========================================

// Episode href = bb-play://<play_url>, e.g. bb-play:///tv/play/<slug>/1/1
async function extractEpisodes(url) {
    const ref = parseHref(url);
    try {
        const d = await bbApi(`${ref.type}/${ref.id}`);
        if (!d) return JSON.stringify([]);

        if (ref.type === "movie") {
            return JSON.stringify([{
                href: `bb-play://${d.play_url}`,
                number: 1,
                season: 1,
                title: d.title || "Movie"
            }]);
        }

                // Seasons the site actually lists (skipping season 0 / specials), with
        // a fallback of 1..number_of_seasons.
        let seasonNumbers = Array.isArray(d.seasons)
            ? d.seasons.map(x => x.season_number).filter(n => n > 0)
            : [];
        if (seasonNumbers.length === 0) {
            const total = parseInt(d.number_of_seasons, 10) || 1;
            for (let n = 1; n <= total; n++) seasonNumbers.push(n);
        }

        // A season-specific href lists just that season; a bare show href
        // (single-season shows) lists all of them.
        let wanted = seasonNumbers;
        if (ref.season !== null && !isNaN(ref.season)) wanted = seasonNumbers.filter(n => n === ref.season);

        const episodes = [];
        const fetched = await Promise.all(wanted.map(n => bbApi(`tv/${ref.id}/season/${n}`)));
        fetched.forEach((sd, i) => {
            const seasonNumber = wanted[i];
            // Some shows use year-style numbers (e.g. 2026); report those as
            // their position in the season list instead.
            const shown = seasonNumber < 100 ? seasonNumber : seasonNumbers.indexOf(seasonNumber) + 1;
            const eps = sd && Array.isArray(sd.episodes) ? sd.episodes : [];
            for (const ep of eps) {
                episodes.push({
                    href: `bb-play://${ep.play_url || `${d.play_url}/${seasonNumber}/${ep.episode_number}`}`,
                    number: ep.episode_number,
                    season: shown,
                    title: ep.name || `Episode ${ep.episode_number}`
                });
            }
        });
        return JSON.stringify(episodes);
    } catch (error) {
        return JSON.stringify([]);
    }
}

// ==========================================
// 🎬 PLAYBACK
// ==========================================

// The play page ships its config as `(function(){var k=[..],d=[..]; ... XOR ... eval})()`.
function extractTicket(html) {
    const km = html.match(/var k=\[([\d,\s]+)\],d=\[([\d,\s]+)\]/);
    if (!km) return "";
    const k = km[1].split(',').map(n => parseInt(n, 10));
    const d = km[2].split(',').map(n => parseInt(n, 10));
    const bytes = new Array(d.length);
    for (let i = 0; i < d.length; i++) bytes[i] = d[i] ^ k[i % k.length];
    const config = utf8Decode(bytes);
    const tm = config.match(/ticket:\s*"([^"]+)"/);
    return tm ? tm[1] : "";
}

async function bbSecure(path, ticket, referer) {
    const headers = {
        "User-Agent": BB_UA,
        "Accept": "*/*",
        "Referer": referer,
        "X-BB-Player": "1",
        "X-BB-Ticket": ticket
    };
    const body = await readBody(await soraFetch(`${BB_BASE}${path}`, { method: 'GET', headers: headers }));
    if (!body) return null;
    let json;
    try { json = JSON.parse(body); } catch (e) { return null; }
    if (json && typeof json.enc === 'string') return decryptPayload(json.enc, ticket);
    return json;
}

// qualities may be an array of {label,url} or a "[1080p]url,[480p]url" string.
function parseQualities(q) {
    const list = [];
    if (Array.isArray(q)) {
        for (const item of q) {
            if (typeof item === 'string') list.push({ label: "", url: item });
            else if (item && item.url) list.push({ label: item.label || item.quality || item.name || "", url: item.url });
        }
    } else if (typeof q === 'string') {
        const re = /\[([^\]]*)\]\s*([^,\[]+)/g;
        let m;
        while ((m = re.exec(q)) !== null) list.push({ label: m[1], url: m[2].trim() });
    }
    return list;
}

async function extractStreamUrl(url) {
    const playPath = String(url).replace('bb-play://', '');
    const pageUrl = `${BB_BASE}${playPath}`;
    const streams = [];

    try {
        const html = await readBody(await soraFetch(pageUrl, {
            method: 'GET',
            headers: { "User-Agent": BB_UA, "Accept": "text/html", "Referer": `${BB_BASE}/` }
        }));

        const ticket = extractTicket(html);
        if (!ticket) {
            console.log(html.indexOf("Quick check") >= 0
                ? "[Player] BingeBang is asking for a bot check (VPN/proxy IP?)"
                : "[Player] No player ticket found on the page");
            return JSON.stringify({ type: "none" });
        }

        const sources = await bbSecure("/api/player/sources", ticket, pageUrl);
        const servers = sources && sources.ok && Array.isArray(sources.servers) ? sources.servers : [];
        if (servers.length === 0) return JSON.stringify({ type: "none" });

        const resolved = await Promise.all(servers.map(srv =>
            bbSecure(`/api/player/resolve?src=${encodeURIComponent(srv.source_url)}`, ticket, pageUrl)
                .then(r => ({ srv: srv, r: r })).catch(() => ({ srv: srv, r: null }))
        ));

        for (const { srv, r } of resolved) {
            if (!r || !r.ok || !r.url) continue;
            const name = srv.label || "Server";
            const add = (label, link) => {
                if (!link || streams.some(s => s.streamUrl === link)) return;
                streams.push({
                    title: label ? `${name} ${label}` : name,
                    streamUrl: link,
                    headers: { "Referer": `${BB_BASE}/`, "User-Agent": BB_UA }
                });
            };
            const qualities = parseQualities(r.qualities);
            if (qualities.length > 0) qualities.forEach(q => add(q.label, q.url));
            else add(srv.quality || "", r.url);
        }

        if (streams.length === 0) return JSON.stringify({ type: "none" });
        return JSON.stringify({
            type: "servers",
            streams: streams,
            subtitles: "",
            subtitlesHeaders: {},
            allSubtitles: []
        });
    } catch (error) {
        console.log(`[Player] BingeBang error: ${error}`);
        return JSON.stringify({ type: "none" });
    }
}
