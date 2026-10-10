const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function searchResults(keyword) {
    const searchUrl = `https://itachi.tv/search?q=${encodeURIComponent(keyword)}`;
    const res = await fetch(searchUrl, {
        headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml"
        }
    });
    
    const html = await res.text();
    const results = [];

    // Split by anchor tags rather than specific classes to make it unbreakable
    const blocks = html.split('<a ');
    
    for (const block of blocks) {
        // Look for any link that routes to an anime page
        const hrefMatch = block.match(/href="(\/anime\/[^"]+)"/);
        if (!hrefMatch) continue;

        // Extract the title
        const titleMatch = block.match(/title="([^"]+)"/);
        const altMatch = block.match(/alt="([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : (altMatch ? altMatch[1] : "Unknown Anime");

        // Extract the image, handling Next.js proxies if present
        let imgUrl = "";
        const imgMatch = block.match(/src="\/_next\/image\?url=([^&"]+)/);
        if (imgMatch) {
            imgUrl = decodeURIComponent(imgMatch[1]);
        } else {
            const rawImgMatch = block.match(/<img[^>]+src="([^"]+)"/);
            if (rawImgMatch) imgUrl = rawImgMatch[1];
        }
        
        const fullUrl = "https://itachi.tv" + hrefMatch[1];
        
        // Push the result if it hasn't been added already
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
    return JSON.stringify([{
        description: "Watch on Itachi TV",
        aliases: "Itachi",
        airdate: ""
    }]);
}

async function extractEpisodes(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const html = await res.text();
    const episodes = [];

    const blocks = html.split('<a ');

    for (const block of blocks) {
        // Look for watch routes instead of specific grid classes
        const hrefMatch = block.match(/href="(\/watch\/[^"]+)"/);
        if (!hrefMatch) continue;

        const epNumMatch = block.match(/>EP\s*(\d+)</); 
        const epTitleMatch = block.match(/<p[^>]*truncate[^>]*>([^<]+)<\/p>/);

        const epNum = epNumMatch ? parseInt(epNumMatch[1].trim(), 10) : episodes.length + 1;
        const epTitle = epTitleMatch ? decodeEntities(epTitleMatch[1].trim()) : `Episode ${epNum}`;
        const fullUrl = "https://itachi.tv" + hrefMatch[1];
        
        if (!episodes.some(e => e.href === fullUrl)) {
            episodes.push({
                title: epTitle,
                href: fullUrl,
                number: epNum,
                season: 1
            });
        }
    }

    return JSON.stringify(episodes);
}

async function extractStreamUrl(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const html = await res.text();

    const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/);
    
    if (iframeMatch) {
        const iframeUrl = iframeMatch[1].replace(/&amp;/g, '&');

        try {
            const iframeRes = await fetch(iframeUrl, { headers: { "User-Agent": UA } });
            const iframeHtml = await iframeRes.text();

            const fileMatch = iframeHtml.match(/['"](https:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
            if (fileMatch) {
                return JSON.stringify({
                    type: "servers",
                    streams: [{
                        title: "Itachi TV HLS",
                        streamUrl: fileMatch[1],
                        headers: {}
                    }],
                    subtitles: "",
                    subtitlesHeaders: {},
                    allSubtitles: []
                });
            }
        } catch (e) {
            console.error("Failed to parse iframe:", e);
        }
    }
    
    return JSON.stringify({ type: "none" });
}

function decodeEntities(text) {
    if (!text) return "";
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&#039;|&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
