// ==========================================
// ⚙️ SORA MODULE — XPASS
// ==========================================
// XPass (play.xpass.top) is an embed host keyed by TMDB or IMDb ids. It has no
// catalogue of its own, so titles/seasons/episodes come from Cinemeta (Stremio's
// free, keyless catalogue, which carries both ids) and only playback talks to
// XPass. Do not use another site's internal ids here: they are not TMDB ids.
//
// Playback (reverse-engineered from the site's own player scripts):
//   1. GET /e/movie/<id>  or  /e/tv/<id>/<season>/<episode>
//      The page carries `var dataUrl="/data/...?autostart=false&token=<signed>"`.
//   2. GET <dataUrl>  (Referer: the embed page)  -> base64url text.
//      Layout: iv(12) + AES-256-GCM ciphertext + tag(16).
//      Key   : sha256("spv3-data-response|<BUILD>|<dataUrl path>|<token>")
//      Plain : [{id, name, url: "/vxr/tv/.../playlist.json"}, ...]  (the servers)
//   3. GET each server url -> {playlist:[{sources:[{file, type, label}]}]}
//      "/video/error" means "this server does not have the title".
//   <BUILD> ("spv3-build-<n>-<hex>") changes when the site redeploys. It is read
//   from the player script at runtime (two small downloads, cached) with the
//   value below as a fallback.
//
// The GCM tag is not verified: a wrong key or build id simply fails to parse as
// JSON, which is reported in the log.

const XP_BASE = "https://play.xpass.top";
const XP_META = "https://v3-cinemeta.strem.io";
const XP_MAX_RESULTS = 10;     // per kind (series / movies)
const XP_FALLBACK_BUILD = "spv3-build-1787821613-50e5fc97c9dce367";
const XP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const XP_MAX_STREAMS = 8;      // stop once this many verified streams are found
const XP_BATCH = 6;            // servers contacted in parallel
const XP_TIMEOUT_MS = 9000;    // per request, when timers are available

let xpBuildCache = "";

// ==========================================
// 🌐 NETWORK
// ==========================================

async function soraFetch(url, options = { headers: {}, method: 'GET', body: null }) {
    const headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = XP_UA;
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

// Resolves to null if the request takes too long (dead hosts are common).
function withTimeout(promise, ms) {
    if (typeof setTimeout !== 'function') return promise;
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}

async function getText(url, headers) {
    return await withTimeout(readBody(await soraFetch(url, { method: 'GET', headers: headers || {} })), XP_TIMEOUT_MS) || "";
}

async function metaApi(path) {
    const body = await getText(`${XP_META}/${path}`, { "Accept": "application/json" });
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
}

// ==========================================
// 🔍 SEARCH
// ==========================================

// Seasons that really have episodes (season 0 = specials, skipped).
function seasonList(meta) {
    const seen = {};
    const list = [];
    const videos = meta && Array.isArray(meta.videos) ? meta.videos : [];
    for (const v of videos) {
        if (v && v.season > 0 && !seen[v.season]) { seen[v.season] = 1; list.push(v.season); }
    }
    return list.sort((a, b) => a - b);
}

// href = xp://<movie|series>/<imdb id>[/<season>]
// Multi-season shows are returned one entry per season so every season has its
// own episode list.
async function searchResults(keyword) {
    try {
        const q = encodeURIComponent(keyword);
        const [seriesData, movieData] = await Promise.all([
            metaApi(`catalog/series/top/search=${q}.json`),
            metaApi(`catalog/movie/top/search=${q}.json`)
        ]);
        const series = ((seriesData && seriesData.metas) || []).filter(m => m && /^tt\d+$/.test(m.id)).slice(0, XP_MAX_RESULTS);
        const movies = ((movieData && movieData.metas) || []).filter(m => m && /^tt\d+$/.test(m.id)).slice(0, XP_MAX_RESULTS);

        const metas = await Promise.all(series.map(m =>
            metaApi(`meta/series/${m.id}.json`).catch(() => null)
        ));

        const results = [];
        series.forEach((m, i) => {
            const label = m.releaseInfo ? `${m.name} (${m.releaseInfo})` : m.name;
            const image = m.poster || "";
            const detail = metas[i] && metas[i].meta;
            const seasons = seasonList(detail);
            if (seasons.length > 1) {
                for (const n of seasons) results.push({ title: `${label} · Season ${n}`, image: image, href: `xp://series/${m.id}/${n}` });
            } else {
                results.push({ title: label, image: image, href: `xp://series/${m.id}` });
            }
        });
        for (const m of movies) {
            results.push({ title: m.releaseInfo ? `${m.name} (${m.releaseInfo})` : m.name, image: m.poster || "", href: `xp://movie/${m.id}` });
        }
        return JSON.stringify(results);
    } catch (error) {
        return JSON.stringify([]);
    }
}

// ==========================================
// 📖 DETAILS
// ==========================================

function parseHref(url) {
    const parts = String(url).replace('xp://', '').split('/');
    return { type: parts[0], id: parts[1], season: parts.length > 2 ? parseInt(parts[2], 10) : null };
}

async function extractDetails(url) {
    const ref = parseHref(url);
    try {
        const data = await metaApi(`meta/${ref.type}/${ref.id}.json`);
        const d = data && data.meta;
        if (!d) throw new Error("no data");

        const genres = Array.isArray(d.genres) ? d.genres.join(", ") : (Array.isArray(d.genre) ? d.genre.join(", ") : "");
        const aliases = [d.runtime ? `Runtime: ${d.runtime}` : "", genres].filter(x => x).join(" | ");
        const airdate = [d.releaseInfo || d.year || "", d.status || ""].filter(x => x).join(" · ");

        return JSON.stringify([{
            description: d.description || "No synopsis available.",
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

// XPass takes the TMDB id when we have it (its default), else the IMDb id.
function playId(meta) {
    return (meta && meta.moviedb_id) ? String(meta.moviedb_id) : String(meta && meta.imdb_id || meta && meta.id);
}

// Episode href = xp-play://movie/<id>  or  xp-play://tv/<id>/<season>/<episode>
async function extractEpisodes(url) {
    const ref = parseHref(url);
    try {
        const data = await metaApi(`meta/${ref.type}/${ref.id}.json`);
        const meta = data && data.meta;
        if (!meta) return JSON.stringify([]);
        const id = playId(meta);

        if (ref.type === "movie") {
            return JSON.stringify([{ href: `xp-play://movie/${id}`, number: 1, season: 1, title: meta.name || "Full Movie" }]);
        }

        const videos = (Array.isArray(meta.videos) ? meta.videos : [])
            .filter(v => v && v.season > 0 && (v.episode || v.number) > 0)
            .filter(v => ref.season === null || isNaN(ref.season) || v.season === ref.season)
            .sort((a, b) => a.season - b.season || (a.episode || a.number) - (b.episode || b.number));

        return JSON.stringify(videos.map(v => {
            const n = v.episode || v.number;
            return {
                href: `xp-play://tv/${id}/${v.season}/${n}`,
                number: n,
                season: v.season,
                title: v.name || v.title || `Episode ${n}`
            };
        }));
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

// base64 with a configurable alphabet (standard/url-safe).
function base64Bytes(str, alphabet) {
    const out = [];
    let buffer = 0, bits = 0;
    for (let i = 0; i < str.length; i++) {
        const v = alphabet.indexOf(str.charAt(i));
        if (v < 0 || v > 63) continue;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 255); buffer &= (1 << bits) - 1; }
    }
    return out;
}

const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
// The player scripts store strings as base64 with lowercase letters first.
const B64_OBF = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";

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

// ---- AES-256 (encrypt direction only; CTR/GCM never needs decryption) ----
let AES_SBOX = null;
function aesInit() {
    if (AES_SBOX) return;
    AES_SBOX = new Array(256);
    let p = 1, q = 1;
    do {
        p = p ^ ((p << 1) & 255) ^ (p & 0x80 ? 0x1b : 0);       // p * 3
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255;        // q / 3
        if (q & 0x80) q ^= 0x09;
        const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
        AES_SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    AES_SBOX[0] = 0x63;
}

function aesExpandKey(key) {               // key: 32 bytes -> 15 round keys of 16 bytes
    aesInit();
    const w = [];
    for (let i = 0; i < 8; i++) w.push(key.slice(i * 4, i * 4 + 4));
    let rcon = 1;
    for (let i = 8; i < 60; i++) {
        let t = w[i - 1].slice();
        if (i % 8 === 0) {
            t = [AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
            rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 255;
        } else if (i % 8 === 4) {
            t = t.map(b => AES_SBOX[b]);
        }
        w.push(w[i - 8].map((b, k) => b ^ t[k]));
    }
    const rk = [];
    for (let r = 0; r < 15; r++) rk.push([].concat(w[r * 4], w[r * 4 + 1], w[r * 4 + 2], w[r * 4 + 3]));
    return rk;
}

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 255; }

function aesEncryptBlock(rk, block) {
    let s = block.map((b, i) => b ^ rk[0][i]);
    for (let round = 1; round <= 14; round++) {
        const t = new Array(16);
        // SubBytes + ShiftRows
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = AES_SBOX[s[((c + r) % 4) * 4 + r]];
        if (round < 14) {                  // MixColumns
            for (let c = 0; c < 4; c++) {
                const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
                s[c * 4]     = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
                s[c * 4 + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
                s[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
                s[c * 4 + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
            }
        } else {
            s = t;
        }
        for (let i = 0; i < 16; i++) s[i] ^= rk[round][i];
    }
    return s;
}

// AES-256-GCM decrypt (CTR mode part only; tag is not checked). Returns bytes.
function aesGcmDecrypt(key, iv, ct) {
    const rk = aesExpandKey(key);
    const out = new Array(ct.length);
    for (let blockIndex = 0; blockIndex * 16 < ct.length; blockIndex++) {
        const counter = blockIndex + 2;    // J0 = iv||1 is reserved for the tag
        const ctr = iv.concat([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]);
        const ks = aesEncryptBlock(rk, ctr);
        for (let j = 0; j < 16 && blockIndex * 16 + j < ct.length; j++) out[blockIndex * 16 + j] = ct[blockIndex * 16 + j] ^ ks[j];
    }
    return out;
}

// Decrypts the /data/... response into the parsed server list (or null).
function decryptServers(blobText, build, dataUrl) {
    const m = String(dataUrl).match(/^([^?]*)\?.*[?&]token=([^&]+)/);
    if (!m) return null;
    const raw = base64Bytes(String(blobText).trim(), B64_URL);
    if (raw.length < 29) return null;
    const key = sha256(utf8Bytes(`spv3-data-response|${build}|${m[1]}|${m[2]}`));
    const plain = aesGcmDecrypt(key, raw.slice(0, 12), raw.slice(12, raw.length - 16));
    try { return JSON.parse(utf8Decode(plain)); } catch (e) { return null; }
}

// ==========================================
// 🎬 PLAYBACK
// ==========================================

// The player scripts hide their string constants as base64 (see B64_OBF).
function obfEncodePrefix(text, length) {
    const bytes = utf8Bytes(text);
    let out = "";
    for (let i = 0; i + 2 < bytes.length && out.length < length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64_OBF.charAt((n >> 18) & 63) + B64_OBF.charAt((n >> 12) & 63) + B64_OBF.charAt((n >> 6) & 63) + B64_OBF.charAt(n & 63);
    }
    return out.slice(0, length);
}

function obfFind(script, plainPrefix) {
    // 12 chars of base64 cover 9 plaintext bytes, which is enough to be unique.
    const enc = obfEncodePrefix(plainPrefix, 12);
    const re = new RegExp("'(" + enc + "[A-Za-z0-9+/=]*)'");
    const m = script.match(re);
    if (!m) return "";
    return utf8Decode(base64Bytes(m[1], B64_OBF));
}

// embed page -> mainmini.js -> player script -> build id
async function discoverBuild(embedHtml) {
    if (xpBuildCache) return xpBuildCache;
    try {
        const sm = embedHtml.match(/src="(\/static\/mainmini\.js[^"]*)"/);
        if (sm) {
            const mainJs = await getText(`${XP_BASE}${sm[1]}`, { "User-Agent": XP_UA });
            const playerPath = obfFind(mainJs, "/static/");
            if (playerPath) {
                const playerJs = await getText(`${XP_BASE}${playerPath}`, { "User-Agent": XP_UA });
                const build = obfFind(playerJs, "spv3-build-");
                if (/^spv3-build-/.test(build)) { xpBuildCache = build; return build; }
            }
        }
    } catch (e) { /* fall through */ }
    return XP_FALLBACK_BUILD;
}

// Absolute url for a playlist entry.
function resolveUrl(ref, base) {
    if (/^https?:\/\//i.test(ref)) return ref;
    const origin = (base.match(/^https?:\/\/[^\/]+/) || [""])[0];
    if (ref.charAt(0) === '/') return origin + ref;
    return base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + ref;
}

function firstUri(playlist) {
    const lines = String(playlist).split(/\r?\n/);
    for (const line of lines) {
        const t = line.trim();
        if (t && t.charAt(0) !== '#') return t;
    }
    return "";
}

// GET a small slice and report whether it looks like real media (not a 403 page).
async function probeSegment(link, headers) {
    const h = Object.assign({}, headers, { "Range": "bytes=0-1023" });
    const response = await withTimeout(soraFetch(link, { method: 'GET', headers: h }), XP_TIMEOUT_MS);
    if (!response) return false;
    if (typeof response.status === 'number' && response.status >= 400) return false;
    const body = await withTimeout(readBody(response), XP_TIMEOUT_MS) || "";
    if (body.length === 0) return false;
    return !(body.length < 600 && /forbidden|denied|permission|not found|<html|error/i.test(body));
}

// Many hosts are dead, and some serve a playlist but refuse the video segments
// (403). Follow the playlist down to its first segment and only keep streams
// whose segment can really be fetched, from this device.
async function checkStream(link, type, headers) {
    if (!(type === "hls" || /\.m3u8(\?|$)/i.test(link))) return true;
    const master = await getText(link, headers);
    if (master.indexOf("#EXTM3U") !== 0) return false;

    let playlist = master, base = link;
    if (master.indexOf("#EXT-X-STREAM-INF") >= 0) {
        const variant = firstUri(master);
        if (!variant) return false;
        base = resolveUrl(variant, link);
        playlist = await getText(base, headers);
        if (playlist.indexOf("#EXTM3U") !== 0) return false;
    }
    const segment = firstUri(playlist);
    if (!segment) return false;
    return await probeSegment(resolveUrl(segment, base), headers);
}

async function extractStreamUrl(url) {
    const path = String(url).replace('xp-play://', '');          // movie/<id> | tv/<id>/<s>/<e>
    const embed = `${XP_BASE}/e/${path}`;
    const streams = [];

    try {
        const html = await getText(embed, { "User-Agent": XP_UA, "Accept": "text/html" });
        const dm = html.match(/var dataUrl="([^"]+)"/);
        if (!dm) {
            console.log("[Player] XPass: no dataUrl on the embed page");
            return JSON.stringify({ type: "none" });
        }
        const dataUrl = dm[1].replace(/&amp;/g, '&');

        const blob = await getText(`${XP_BASE}${dataUrl}`, { "User-Agent": XP_UA, "Referer": embed, "Accept": "*/*" });
        if (!blob) {
            console.log("[Player] XPass: empty data response (token rejected?)");
            return JSON.stringify({ type: "none" });
        }

        let servers = decryptServers(blob, await discoverBuild(html), dataUrl);
        if (!Array.isArray(servers) && xpBuildCache) {
            servers = decryptServers(blob, XP_FALLBACK_BUILD, dataUrl);      // discovered id may be wrong
        }
        if (!Array.isArray(servers) || servers.length === 0) {
            console.log("[Player] XPass: could not decrypt the server list (build id changed?)");
            return JSON.stringify({ type: "none" });
        }

        // Referer only: sending Origin as well makes some hosts (e.g. vip.1x2.space) answer 403.
        const streamHeaders = { "Referer": `${XP_BASE}/`, "User-Agent": XP_UA };

        for (let i = 0; i < servers.length && streams.length < XP_MAX_STREAMS; i += XP_BATCH) {
            const batch = servers.slice(i, i + XP_BATCH);
            const found = await Promise.all(batch.map(async (server) => {
                const out = [];
                if (!server || !server.url) return out;
                const text = await getText(`${XP_BASE}${server.url}`, { "User-Agent": XP_UA, "Referer": embed, "Accept": "*/*" });
                let data;
                try { data = JSON.parse(text); } catch (e) { return out; }
                const items = data && Array.isArray(data.playlist) ? data.playlist : [];
                for (const item of items) {
                    for (const src of (item.sources || [])) {
                        if (!src || !src.file || src.file === "/video/error") continue;
                        let link = src.file;
                        if (link.charAt(0) === '/') link = `${XP_BASE}${link}`;
                        if (!(await checkStream(link, src.type, streamHeaders))) continue;
                        out.push({
                            title: `[XPass] ${src.label || server.name || "Server"}`,
                            streamUrl: link,
                            headers: streamHeaders
                        });
                    }
                }
                return out;
            }));
            for (const list of found) {
                for (const s of list) {
                    if (streams.length < XP_MAX_STREAMS && !streams.some(x => x.streamUrl === s.streamUrl)) streams.push(s);
                }
            }
        }

        if (streams.length === 0) {
            console.log("[Player] XPass: no server has this title");
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
        console.log(`[Player] XPass error: ${error}`);
        return JSON.stringify({ type: "none" });
    }
}
