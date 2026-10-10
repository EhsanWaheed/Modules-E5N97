const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Custom network bridge to bypass iOS WebKit blocks
async function shiroxFetch(url) {
    const headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://itachi.tv/"
    };
    try {
        if (typeof fetchv2 !== 'undefined') {
            // Use Shirox's native iOS fetch
            const res = await fetchv2(url, headers, 'GET', null);
            return res.data || (typeof res.text === 'function' ? await res.text() : String(res));
        } else {
            // Fallback for standard environments
            const res = await fetch(url, { headers });
            return await res.text();
        }
    } catch (e) {
        console.error("Fetch failed:", e);
        return "";
    }
}

async function searchResults(keyword) {
    const searchUrl = `https://itachi.tv/search?q=${encodeURIComponent(keyword)}`;
    const html = await shiroxFetch(searchUrl);
    const results = [];

    const blocks = html.split('<a ');
    
    for (const block of blocks) {
        const hrefMatch = block.match(/href="(\/anime\/[^"]+)"/);
        if (!hrefMatch) continue;

        const titleMatch = block.match(/title="([^"]+)"/) || block.match(/alt="([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : "Unknown Anime";

        let imgUrl = "";
        const imgMatch = block.match(/src="\/_next\/image\?url=([^&"]+)/);
        if (imgMatch) {
            imgUrl = decodeURIComponent(imgMatch[1]);
        } else {
            const rawImgMatch = block.match(/<img[^>]+src="([^"]+)"/);
            if (rawImgMatch) imgUrl = rawImgMatch[1];
        }
        
        const fullUrl = "https://itachi.tv" + hrefMatch[1];
        
        if (!results.some(r => r.href === fullUrl)) {
            results.push({
                title: decodeEntities(title),
                href: fullUrl,
                image: imgUrl
            });
        }
    }
    return JSON.stringify(results);
}

async function extractDetails(url) {
    return JSON.stringify([{ description: "Watch on Itachi TV", aliases: "Itachi TV", airdate: "" }]);
}

async function extractEpisodes(url) {
    const html = await shiroxFetch(url);
    const episodes = [];
    const blocks = html.split('<a ');

    for (const block of blocks) {
        const hrefMatch = block.match(/href="(\/watch\/[^"]+)"/);
        if (!hrefMatch) continue;

        const epNumMatch = block.match(/>EP\s*(\d+)</); 
        const epTitleMatch = block.match(/<p[^>]*truncate[^>]*>([^<]+)<\/p>/);

        const epNum = epNumMatch ? parseInt(epNumMatch[1].trim(), 10) : episodes.length + 1;
        const epTitle = epTitleMatch ? decodeEntities(epTitleMatch[1].trim()) : `Episode ${epNum}`;
        const fullUrl = "https://itachi.tv" + hrefMatch[1];
        
        if (!episodes.some(e => e.href === fullUrl)) {
            episodes.push({ title: epTitle, href: fullUrl, number: epNum, season: 1 });
        }
    }
    return JSON.stringify(episodes);
}

async function extractStreamUrl(url) {
    const html = await shiroxFetch(url);
    const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/);
    
    if (iframeMatch) {
        const iframeUrl = iframeMatch[1].replace(/&amp;/g, '&');
        try {
            const iframeHtml = await shiroxFetch(iframeUrl);
            const fileMatch = iframeHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
            if (fileMatch) {
                return JSON.stringify({
                    type: "servers",
                    streams: [{ title: "Itachi TV HLS", streamUrl: fileMatch[1], headers: {} }],
                    subtitles: "", subtitlesHeaders: {}, allSubtitles: []
                });
            }
        } catch (e) {}
    }
    return JSON.stringify({ type: "none" });
}

function decodeEntities(text) {
    if (!text) return "";
    return String(text).replace(/&amp;/g, '&').replace(/&#039;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
