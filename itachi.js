const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANILIST_API = "https://graphql.anilist.co";

// ==========================================
// 🌐 NATIVE NETWORK BRIDGE
// ==========================================
async function soraFetch(url, options = { headers: {}, method: 'GET', body: null }) {
    const headers = options.headers || {};
    if (!headers["User-Agent"]) headers["User-Agent"] = UA;
    if (!headers["Accept"]) headers["Accept"] = "application/json, text/html";
    
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
    return String(text).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function anilistQuery(query, variables) {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    const body = JSON.stringify({ query, variables });
    const response = await soraFetch(ANILIST_API, { method: 'POST', headers, body });
    const text = await readBody(response);
    if (!text) return null;
    try {
        return JSON.parse(text).data;
    } catch (e) { return null; }
}

// ==========================================
// 🔍 SEARCH (Powered by AniList API)
// ==========================================
async function searchResults(keyword) {
    const query = `query ($search: String) {
      Page(page: 1, perPage: 20) {
        media(search: $search, type: ANIME, isAdult: false) {
          id
          title { romaji english native }
          coverImage { extraLarge large }
        }
      }
    }`;
    
    const data = await anilistQuery(query, { search: keyword });
    const media = data?.Page?.media || [];
    
    const results = [];
    for (const item of media) {
        const title = item.title.english || item.title.romaji || item.title.native;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        results.push({
            title: title,
            href: `https://itachi.tv/anime/${item.id}/${slug}`,
            image: item.coverImage?.extraLarge || item.coverImage?.large || ""
        });
    }
    
    return JSON.stringify(results);
}

// ==========================================
// 📖 DETAILS
// ==========================================
async function extractDetails(url) {
    const matchId = url.match(/\/anime\/(\d+)/);
    const id = matchId ? parseInt(matchId[1], 10) : 0;
    
    const query = `query ($id: Int) {
      Media(id: $id, type: ANIME) {
        description
        status
        seasonYear
        averageScore
        genres
      }
    }`;
    
    const data = await anilistQuery(query, { id });
    const media = data?.Media;
    
    if (!media) return JSON.stringify([{ description: "Watch on Itachi TV", aliases: "", airdate: "" }]);
    
    const aliases = [];
    if (media.averageScore) aliases.push(`Score: ${media.averageScore}%`);
    if (media.genres && media.genres.length) aliases.push(media.genres.join(', '));
    
    let airdate = media.seasonYear ? `Year: ${media.seasonYear}` : "";
    if (media.status) airdate += airdate ? ` · ${media.status}` : media.status;
    
    return JSON.stringify([{
        description: decodeEntities(media.description) || "No synopsis available.",
        aliases: aliases.join(' | '),
        airdate: airdate
    }]);
}

// ==========================================
// 📂 EPISODES
// ==========================================
async function extractEpisodes(url) {
    const matchId = url.match(/\/anime\/(\d+)/);
    const anilistId = matchId ? matchId[1] : "";

    const response = await soraFetch(url);
    const html = await readBody(response);
    
    const episodes = [];
    const seen = new Set();

    // 1. Try to extract exact episodes from Itachi TV's static payload
    const regex = new RegExp(`(?:href="|"href":"|href:|\\\\")(\\\\/watch\\\\/${anilistId}\\\\/[^"\\']+?\\\\/(\\d+))`, 'g');
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1].replace(/\\/g, ''); 
        const epNumStr = match[2];
        
        if (seen.has(path)) continue;
        seen.add(path);

        const epNum = parseInt(epNumStr, 10);
        const snippet = html.substring(Math.max(0, match.index - 400), match.index + 400);
        const epTitleMatch = snippet.match(/<p[^>]*truncate[^>]*>([^<]+)<\/p>/);
        const epTitle = epTitleMatch ? decodeEntities(epTitleMatch[1].trim()) : `Episode ${epNum}`;

        episodes.push({
            title: epTitle,
            href: `https://anilink.cc/watch/${anilistId}/${epNum}`,
            number: epNum,
            season: 1
        });
    }

    // 2. Fallback: If Itachi TV blocks the page, generate episodes via AniList API
    if (episodes.length === 0 && anilistId) {
        const query = `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            episodes
            nextAiringEpisode { episode }
          }
        }`;
        const data = await anilistQuery(query, { id: parseInt(anilistId, 10) });
        const media = data?.Media;
        let totalEps = 1;
        if (media) {
            if (media.nextAiringEpisode?.episode) totalEps = media.nextAiringEpisode.episode - 1;
            else if (media.episodes) totalEps = media.episodes;
            else totalEps = 1150; // Fallback for massive ongoing shows like One Piece
        }
        for (let i = 1; i <= totalEps; i++) {
            episodes.push({
                title: `Episode ${i}`,
                href: `https://anilink.cc/watch/${anilistId}/${i}`,
                number: i,
                season: 1
            });
        }
    }

    episodes.sort((a, b) => a.number - b.number);
    return JSON.stringify(episodes);
}

// ==========================================
// 🎬 PLAYBACK
// ==========================================
async function extractStreamUrl(url) {
    const streams = [];

    // Attempt to pull Sub track
    const subUrl = url + "?variant=sub";
    const subRes = await soraFetch(subUrl);
    const subHtml = await readBody(subRes);
    const subMatch = subHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
    if (subMatch) {
        streams.push({
            title: "Itachi TV (Sub)",
            streamUrl: subMatch[1],
            headers: { "Referer": "https://anilink.cc/", "User-Agent": UA }
        });
    }

    // Attempt to pull Dub track
    const dubUrl = url + "?variant=dub";
    const dubRes = await soraFetch(dubUrl);
    const dubHtml = await readBody(dubRes);
    const dubMatch = dubHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
    if (dubMatch) {
        streams.push({
            title: "Itachi TV (Dub)",
            streamUrl: dubMatch[1],
            headers: { "Referer": "https://anilink.cc/", "User-Agent": UA }
        });
    }

    if (streams.length > 0) {
        return JSON.stringify({
            type: "servers",
            streams: streams,
            subtitles: "", subtitlesHeaders: {}, allSubtitles: []
        });
    }

    return JSON.stringify({ type: "none" });
}async function searchResults(keyword) {
    // Hits the correct /browse endpoint found in the network logs
    const searchUrl = `https://itachi.tv/browse?query=${encodeURIComponent(keyword)}`;
    const response = await soraFetch(searchUrl);
    const html = await readBody(response);
    
    const results = [];
    const seen = new Set();

    // Aggressive Regex to rip /anime/... links directly out of the raw payload
    const regex = /(?:href="|"href":"|href:|\\")(\/anime\/\d+\/([^"'\\]+))/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1]; 
        const slug = match[2]; 

        if (seen.has(path)) continue;
        seen.add(path);

        const fallbackTitle = slug.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

        const snippet = html.substring(Math.max(0, match.index - 500), match.index + 500);
        const titleMatch = snippet.match(/title="([^"]+)"/) || snippet.match(/"title":"([^"]+)"/) || snippet.match(/alt="([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : fallbackTitle;

        let imgUrl = "";
        const imgMatch = snippet.match(/_next\/image\?url=([^&"\\]+)/);
        if (imgMatch) {
            imgUrl = decodeURIComponent(imgMatch[1]);
        } else {
            const rawImgMatch = snippet.match(/<img[^>]+src="([^"\\]+)"/);
            if (rawImgMatch) imgUrl = rawImgMatch[1];
        }

        results.push({
            title: decodeEntities(title),
            href: "https://itachi.tv" + path,
            image: imgUrl
        });
    }
    
    return JSON.stringify(results);
}

// ==========================================
// 📖 DETAILS & EPISODES
// ==========================================
async function extractDetails(url) {
    return JSON.stringify([{ description: "Watch on Itachi TV", aliases: "Itachi", airdate: "" }]);
}

async function extractEpisodes(url) {
    const response = await soraFetch(url);
    const html = await readBody(response);
    
    const episodes = [];
    const seen = new Set();

    // Aggressive Regex for episode routes: /watch/97940/black-clover/1
    const regex = /(?:href="|"href":"|href:|\\")(\/watch\/\d+\/[^\/]+\/(\d+))/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1];
        const epNumStr = match[2];
        
        if (seen.has(path)) continue;
        seen.add(path);

        const epNum = parseInt(epNumStr, 10);
        
        const snippet = html.substring(Math.max(0, match.index - 400), match.index + 400);
        const epTitleMatch = snippet.match(/<p[^>]*truncate[^>]*>([^<]+)<\/p>/);
        const epTitle = epTitleMatch ? decodeEntities(epTitleMatch[1].trim()) : `Episode ${epNum}`;

        episodes.push({
            title: epTitle,
            href: "https://itachi.tv" + path,
            number: epNum,
            season: 1
        });
    }

    // Ensure episodes are listed sequentially 
    episodes.sort((a, b) => a.number - b.number);
    return JSON.stringify(episodes);
}

// ==========================================
// 🎬 PLAYBACK
// ==========================================
async function extractStreamUrl(url) {
    const response = await soraFetch(url);
    const html = await readBody(response);

    const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/);
    
    if (iframeMatch) {
        const iframeUrl = iframeMatch[1].replace(/&amp;/g, '&');

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
                        headers: { "User-Agent": UA }
                    }],
                    subtitles: "", subtitlesHeaders: {}, allSubtitles: []
                });
            }
        } catch (e) {
            console.error("Iframe extraction failed:", e);
        }
    }
    
    return JSON.stringify({ type: "none" });
}
