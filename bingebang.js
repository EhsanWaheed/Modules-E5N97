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
// 🔐 CRYPTO (pure JS — Sora has no guaranteed WebCrypto)
// ==========================================

function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
            const d = str.charCodeAt(i + 1);
            if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

function utf8Decode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i++];
        if (b < 0x80) s += String.fromCharCode(b);
        else if (b < 0xe0) s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
        else if (b < 0xf0) s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        else {
            const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            const c = cp - 0x10000;
            s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
        }
    }
    return s;
}

function b64urlToBytes(str) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const clean = String(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const out = [];
    let buffer = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const v = alphabet.indexOf(clean.charAt(i));
        if (v < 0) continue;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 255); buffer &= (1 << bits) - 1; }
    }
    return out;
}

const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

// SHA-256 over an array of byte values; returns an array of 32 byte values.
function sha256(bytes) {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const msg = bytes.slice();
    const bitLen = bytes.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    const w = new Array(64);
    for (let off = 0; off < msg.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) | 0;
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    const out = [];
    for (let i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
    return out;
}

// Decrypts the {enc} payload of the player API into parsed JSON (or null).
function decryptPayload(enc, ticket) {
    const raw = b64urlToBytes(enc);
    if (raw.length <= 16) return null;
    const key = sha256(utf8Bytes(BB_KEY_PREFIX + ticket));
    const nonce = raw.slice(0, 16);
    const ct = raw.slice(16);
    const out = new Array(ct.length);
    for (let block = 0; block * 32 < ct.length; block++) {
        const ks = sha256(key.concat(nonce, [(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]));
        for (let j = 0; j < 32 && block * 32 + j < ct.length; j++) out[block * 32 + j] = ct[block * 32 + j] ^ ks[j];
    }
    try { return JSON.parse(utf8Decode(out)); } catch (e) { return null; }
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
        if (servers.length === 0) {
            console.log(`[Player] BingeBang sources empty${sources && sources.error ? ": " + sources.error : ""}${sources && sources.status ? " (status " + sources.status + ")" : ""}`);
            return JSON.stringify({ type: "none" });
        }

        // Resolve one server at a time and stop at the first that works, as
        // the site's own player does. Every resolve counts against a rate
        // limit, so resolving all servers up front can get the viewer a 429.
        for (const srv of servers) {
            const r = await bbSecure(`/api/player/resolve?src=${encodeURIComponent(srv.source_url)}`, ticket, pageUrl)
                .catch(() => null);
            if (r && r.status === 429) {
                console.log(`[Player] BingeBang rate limited, retry after ${r.retry_after || "?"}s`);
                break;
            }
            if (!r || !r.ok || !r.url) {
                console.log(`[Player] BingeBang server "${srv.label}" did not resolve${r && r.error ? ": " + r.error : ""}`);
                continue;
            }
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
            if (streams.length > 0) break;
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
