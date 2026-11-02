// ==========================================
// ⚙️ SORA MODULE — BINGEBANG
// ==========================================
// bingebang.st serves a TMDB-shaped JSON API under /api (verified live):
//
//   Search   GET /api/search/multi?query=<text>
//            -> {results:[{id, media_type: "movie"|"tv", title|name,
//                          poster_path, overview, year, url, play_url}]}
//   Details  GET /api/<movie|tv>/<id>      (tv carries `seasons`)
//   Season   GET /api/tv/<id>/season/<n>
//            -> {episodes:[{episode_number, name, play_url, ...}]}
//            play_url looks like /tv/play/<slug>/<season>/<episode>
//
// Posters are plain TMDB paths: https://image.tmdb.org/t/p/w342<poster_path>
//
// PLAYBACK — NOT YET IMPLEMENTED.
// /tv/play/... and /movie/play/... are gated by a Cloudflare Turnstile check
// (POST /api/player/gate) for requests it considers VPN/proxy traffic, which
// includes the cloud machine this was written on, so the real player request
// could not be observed. extractStreamUrl() below returns "none" until the
// stream request seen in a normal browser is known.

const BB_BASE = "https://bingebang.st";
const BB_IMG = "https://image.tmdb.org/t/p/w342";
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

// href = bb://<movie|tv>/<id>
async function searchResults(keyword) {
    try {
        const data = await bbApi(`search/multi?query=${encodeURIComponent(keyword)}`);
        const list = data && Array.isArray(data.results) ? data.results : [];

        const results = [];
        for (const r of list) {
            if (r.media_type !== "movie" && r.media_type !== "tv") continue;
            const title = r.media_type === "tv" ? (r.name || r.original_name) : (r.title || r.original_title);
            if (!title) continue;
            const label = r.year ? `${title} (${r.year})` : title;
            results.push({
                title: label,
                image: r.poster_path ? `${BB_IMG}${r.poster_path}` : "",
                href: `bb://${r.media_type}/${r.id}`
            });
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
    const parts = String(url).replace('bb://', '').split('/');
    return { type: parts[0], id: parts[1] };
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

        // Skip season 0 (specials); use the seasons the site lists, falling
        // back to 1..number_of_seasons.
        let seasonNumbers = Array.isArray(d.seasons)
            ? d.seasons.map(s => s.season_number).filter(n => n > 0)
            : [];
        if (seasonNumbers.length === 0) {
            const total = parseInt(d.number_of_seasons, 10) || 1;
            for (let n = 1; n <= total; n++) seasonNumbers.push(n);
        }

        const episodes = [];
        const seasons = await Promise.all(seasonNumbers.map(n => bbApi(`tv/${ref.id}/season/${n}`)));
        seasons.forEach((s, i) => {
            const seasonNumber = seasonNumbers[i];
            const eps = s && Array.isArray(s.episodes) ? s.episodes : [];
            for (const ep of eps) {
                episodes.push({
                    href: `bb-play://${ep.play_url || `${d.play_url}/${seasonNumber}/${ep.episode_number}`}`,
                    number: ep.episode_number,
                    season: i + 1, // ordinal; some shows use year-style numbers (e.g. 2026)
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
// 🎬 PLAYBACK  (TODO — see header note)
// ==========================================

async function extractStreamUrl(url) {
    const playPath = String(url).replace('bb-play://', '');
    console.log(`[Player] BingeBang playback not implemented yet: ${BB_BASE}${playPath}`);
    return JSON.stringify({ type: "none" });
}
