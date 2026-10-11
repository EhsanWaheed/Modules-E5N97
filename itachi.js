const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ==========================================
// 🌐 NATIVE NETWORK BRIDGE
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

// ==========================================
// 🔍 SEARCH
// ==========================================
async function searchResults(keyword) {
    const searchUrl = `https://itachi.tv/search?q=${encodeURIComponent(keyword)}`;
    const response = await soraFetch(searchUrl);
    const html = await readBody(response);
    
    const results = [];
    const seen = new Set();

    // Aggressively match Next.js payload structure to locate routing links
    const regex = /(?:href="|"href":"|href:|\\")(\/anime\/(\d+)\/([^"'\\]+))/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const path = match[1]; 
        const slug = match[3];

        if (seen.has(path)) continue;
        seen.add(path);

        const snippet = html.substring(Math.max(0, match.index - 600), match.index + 600);
        
        // Extract Title
        const titleMatch = snippet.match(/title="([^"]+)"/) || snippet.match(/"title":"([^"]+)"/) || snippet.match(/alt="([^"]+)"/);
        const fallbackTitle = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const title = titleMatch ? titleMatch[1] : fallbackTitle;

        // Extract High-Res Next.js Poster Image
        let imgUrl = "";
        const imgMatch = snippet.match(/_next\/image\?url=([^&"\\]+)/) || snippet.match(/"coverImage":"([^"\\]+)"/);
        if (imgMatch) {
            imgUrl = decodeURIComponent(imgMatch[1]);
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
// 📖 DETAILS
// ==========================================
async function extractDetails(url) {
    return JSON.stringify([{ description: "Watch on Itachi TV", aliases: "Itachi TV", airdate: "" }]);
}

// ==========================================
// 📂 EPISODES
// ==========================================
async function extractEpisodes(url) {
    const response = await soraFetch(url);
    const html = await readBody(response);
    
    const episodes = [];
    const seen = new Set();

    const regex = /(?:href="|"href":"|href:|\\")(\/watch\/\d+\/[^\/]+\/(\d+))/g;
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
            href: "https://itachi.tv" + path,
            number: epNum,
            season: 1
        });
    }

    episodes.sort((a, b) => a.number - b.number);
    return JSON.stringify(episodes);
}

// ==========================================
// 🎬 PLAYBACK
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
