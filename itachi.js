const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://itachi.tv";
const ANILIST = "https://graphql.anilist.co";

// ==========================================
// NATIVE NETWORK BRIDGE
// ==========================================
async function soraFetch(url, options = { headers: {}, method: 'GET', body: null }) {
    const headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = UA;
    if (!headers["Accept"]) headers["Accept"] = "text/html,application/xhtml+xml,application/json";

    try {
        if (typeof fetchv2 !== 'undefined') {
            return await fetchv2(url, headers, options.method ?? 'GET', options.body ?? null);
        } else {
            return await fetch(url, { ...options, headers: headers });
        }
    } catch (e) {
        return null;
    }
}

async function readBody(response) {
    if (!response) return "";
    if (typeof response.text === 'function') return await response.text();
    if (typeof response.data === 'string') return response.data;
    return "";
}

function decodeEntities(text) {
    if (!text) return "";
    return String(text)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#039;|&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function makeSlug(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// Itachi anime IDs appear to match AniList IDs (e.g. /anime/20/naruto)
async function anilistQuery(query, variables) {
    const res = await soraFetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables })
    });
    try {
        return JSON.parse(await readBody(res));
    } catch (e) {
        return null;
    }
}

// ==========================================
// SEARCH
// ==========================================
async function searchResults(keyword) {
    try {
        const json = await anilistQuery(`
            query ($search: String) {
                Page(perPage: 25) {
                    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                        id
                        title { romaji english }
                        coverImage { large }
                    }
                }
            }`, { search: keyword });

        const list = json.data.Page.media || [];
        return JSON.stringify(list.map(m => {
            const name = m.title.english || m.title.romaji;
            const slug = makeSlug(m.title.romaji || name);
            return {
                title: name,
                href: `${SITE}/anime/${m.id}/${slug}`,
                image: m.coverImage.large
            };
        }));
    } catch (e) {
        return JSON.stringify([]);
    }
}

// ==========================================
// DETAILS
// ==========================================
async function extractDetails(url) {
    const fallback = JSON.stringify([{ description: "Watch on Itachi TV", aliases: "Itachi TV", airdate: "" }]);
    try {
        const idMatch = url.match(/\/anime\/(\d+)/);
        if (!idMatch) return fallback;

        const json = await anilistQuery(`
            query ($id: Int) {
                Media(id: $id, type: ANIME) {
                    description
                    synonyms
                    title { romaji english native }
                    startDate { year month day }
                }
            }`, { id: parseInt(idMatch[1], 10) });

        const m = json.data.Media;
        const d = m.startDate || {};
        const airdate = d.year ? [d.year, d.month, d.day].filter(Boolean).join("-") : "";
        const aliases = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])]
            .filter(Boolean)
            .join(", ");

        return JSON.stringify([{
            description: decodeEntities((m.description || "").replace(/<br\s*\/?>/g, "\n")) || "Watch on Itachi TV",
            aliases: aliases || "Itachi TV",
            airdate: airdate
        }]);
    } catch (e) {
        return fallback;
    }
}

// ==========================================
// EPISODES
// ==========================================
async function extractEpisodes(url) {
    const idMatch = url.match(/\/anime\/(\d+)\/([^\/?#]+)/);

    // Build the episode list from AniList's episode count
    if (idMatch) {
        try {
            const id = parseInt(idMatch[1], 10);
            const slug = idMatch[2];
            const json = await anilistQuery(`
                query ($id: Int) {
                    Media(id: $id, type: ANIME) {
                        episodes
                        nextAiringEpisode { episode }
                    }
                }`, { id: id });

            const m = json.data.Media;
            let count = m.episodes;
            if (!count && m.nextAiringEpisode) count = m.nextAiringEpisode.episode - 1;

            if (count && count > 0) {
                const episodes = [];
                for (let n = 1; n <= count; n++) {
                    episodes.push({
                        title: `Episode ${n}`,
                        href: `${SITE}/watch/${id}/${slug}/${n}`,
                        number: n,
                        season: 1
                    });
                }
                return JSON.stringify(episodes);
            }
        } catch (e) {}
    }

    // Fallback: scrape the page (only works if the site ever server-renders episode links)
    const response = await soraFetch(url);
    const html = await readBody(response);

    const episodes = [];
    const seen = new Set();
    const regex = /(?:href="|"href":"|href:|\\")(\/watch\/\d+\/[^\/]+\/(\d+))/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1].replace(/\\/g, '');
        if (seen.has(path)) continue;
        seen.add(path);

        const epNum = parseInt(match[2], 10);
        episodes.push({
            title: `Episode ${epNum}`,
            href: SITE + path,
            number: epNum,
            season: 1
        });
    }

    episodes.sort((a, b) => a.number - b.number);
    return JSON.stringify(episodes);
}

// ==========================================
// PLAYBACK (unverified: the watch page is probably client-rendered too)
// ==========================================
async function extractStreamUrl(url) {
    const response = await soraFetch(url);
    const html = await readBody(response);

    const iframeMatch = html.match(/<iframe[^>]*src="([^"\\]+)"/);

    if (iframeMatch) {
        const iframeUrl = iframeMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&');

        try {
            const iframeRes = await soraFetch(iframeUrl);
            const iframeHtml = await readBody(iframeRes);

            const fileMatch = iframeHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
            if (fileMatch) {
                return JSON.stringify({
                    type: "servers",
                    streams: [{
                        title: "Itachi HLS",
                        streamUrl: fileMatch[1],
                        headers: { "Referer": "https://anilink.cc/", "User-Agent": UA }
                    }],
                    subtitles: "", subtitlesHeaders: {}, allSubtitles: []
                });
            }
        } catch (e) {}
    }

    return JSON.stringify({ type: "none" });
}        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function makeSlug(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// Itachi anime IDs appear to match AniList IDs (e.g. /anime/20/naruto)
async function anilistQuery(query, variables) {
    const res = await soraFetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables })
    });
    try {
        return JSON.parse(await readBody(res));
    } catch (e) {
        return null;
    }
}

// ==========================================
// SEARCH
// ==========================================
async function searchResults(keyword) {
    try {
        const json = await anilistQuery(`
            query ($search: String) {
                Page(perPage: 25) {
                    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                        id
                        title { romaji english }
                        coverImage { large }
                    }
                }
            }`, { search: keyword });

        const list = json.data.Page.media || [];
        return JSON.stringify(list.map(m => {
            const name = m.title.english || m.title.romaji;
            const slug = makeSlug(m.title.romaji || name);
            return {
                title: name,
                href: `${SITE}/anime/${m.id}/${slug}`,
                image: m.coverImage.large
            };
        }));
    } catch (e) {
        return JSON.stringify([]);
    }
}

// ==========================================
// DETAILS
// ==========================================
async function extractDetails(url) {
    const fallback = JSON.stringify([{ description: "Watch on Itachi TV", aliases: "Itachi TV", airdate: "" }]);
    try {
        const idMatch = url.match(/\/anime\/(\d+)/);
        if (!idMatch) return fallback;

        const json = await anilistQuery(`
            query ($id: Int) {
                Media(id: $id, type: ANIME) {
                    description
                    synonyms
                    title { romaji english native }
                    startDate { year month day }
                }
            }`, { id: parseInt(idMatch[1], 10) });

        const m = json.data.Media;
        const d = m.startDate || {};
        const airdate = d.year ? [d.year, d.month, d.day].filter(Boolean).join("-") : "";
        const aliases = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])]
            .filter(Boolean)
            .join(", ");

        return JSON.stringify([{
            description: decodeEntities((m.description || "").replace(/<br\s*\/?>/g, "\n")) || "Watch on Itachi TV",
            aliases: aliases || "Itachi TV",
            airdate: airdate
        }]);
    } catch (e) {
        return fallback;
    }
}

// ==========================================
// EPISODES
// ==========================================
async function extractEpisodes(url) {
    const idMatch = url.match(/\/anime\/(\d+)\/([^\/?#]+)/);

    // Build the episode list from AniList's episode count
    if (idMatch) {
        try {
            const id = parseInt(idMatch[1], 10);
            const slug = idMatch[2];
            const json = await anilistQuery(`
                query ($id: Int) {
                    Media(id: $id, type: ANIME) {
                        episodes
                        nextAiringEpisode { episode }
                    }
                }`, { id: id });

            const m = json.data.Media;
            let count = m.episodes;
            if (!count && m.nextAiringEpisode) count = m.nextAiringEpisode.episode - 1;

            if (count && count > 0) {
                const episodes = [];
                for (let n = 1; n <= count; n++) {
                    episodes.push({
                        title: `Episode ${n}`,
                        href: `${SITE}/watch/${id}/${slug}/${n}`,
                        number: n,
                        season: 1
                    });
                }
                return JSON.stringify(episodes);
            }
        } catch (e) {}
    }

    // Fallback: scrape the page (only works if the site ever server-renders episode links)
    const response = await soraFetch(url);
    const html = await readBody(response);

    const episodes = [];
    const seen = new Set();
    const regex = /(?:href="|"href":"|href:|\\")(\/watch\/\d+\/[^\/]+\/(\d+))/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1].replace(/\\/g, '');
        if (seen.has(path)) continue;
        seen.add(path);

        const epNum = parseInt(match[2], 10);
        episodes.push({
            title: `Episode ${epNum}`,
            href: SITE + path,
            number: epNum,
            season: 1
        });
    }

    episodes.sort((a, b) => a.number - b.number);
    return JSON.stringify(episodes);
}

// ==========================================
// PLAYBACK (unverified: the watch page is probably client-rendered too)
// ==========================================
async function extractStreamUrl(url) {
    const response = await soraFetch(url);
    const html = await readBody(response);

    const iframeMatch = html.match(/<iframe[^>]*src="([^"\\]+)"/);

    if (iframeMatch) {
        const iframeUrl = iframeMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&');

        try {
            const iframeRes = await soraFetch(iframeUrl);
            const iframeHtml = await readBody(iframeRes);

            const fileMatch = iframeHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
            if (fileMatch) {
                return JSON.stringify({
                    type: "servers",
                    streams: [{
                        title: "Itachi HLS",
                        streamUrl: fileMatch[1],
                        headers: { "Referer": "https://anilink.cc/", "User-Agent": UA }
                    }],
                    subtitles: "", subtitlesHeaders: {}, allSubtitles: []
                });
            }
        } catch (e) {}
    }

    return JSON.stringify({ type: "none" });
}
