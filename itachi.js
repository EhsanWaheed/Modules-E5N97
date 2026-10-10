async function searchResults(keyword) {
    const searchUrl = `https://itachi.tv/search?q=${encodeURIComponent(keyword)}`;
    const res = await fetch(searchUrl);
    const html = await res.text();
    const results = [];

    // Split the HTML using the anchor class wrapping each search result
    const blocks = html.split('<a class="group block min-w-0').slice(1);
    
    for (const block of blocks) {
        const titleMatch = block.match(/title="([^"]+)"/);
        const hrefMatch = block.match(/href="([^"]+)"/);
        const imgMatch = block.match(/src="\/_next\/image\?url=([^&"]+)/);

        if (titleMatch && hrefMatch) {
            let imgUrl = "";
            if (imgMatch) {
                // Decode the Next.js optimized image URL for high-res posters
                imgUrl = decodeURIComponent(imgMatch[1]);
            }
            
            results.push({
                title: titleMatch[1],
                href: "https://itachi.tv" + hrefMatch[1],
                image: imgUrl
            });
        }
    }
    
    return JSON.stringify(results);
}

// Shirox requires a details route to load the description before displaying episodes
async function extractDetails(url) {
    return JSON.stringify([{
        description: "Watch on Itachi TV",
        aliases: "Itachi",
        airdate: ""
    }]);
}

async function extractEpisodes(url) {
    const res = await fetch(url);
    const html = await res.text();
    const episodes = [];

    // Split the HTML using the anchor class wrapping each episode button
    const blocks = html.split('<a class="group grid min-w-0').slice(1);

    for (const block of blocks) {
        const hrefMatch = block.match(/href="([^"]+)"/);
        const epNumMatch = block.match(/>EP\s*(\d+)</); 
        const epTitleMatch = block.match(/<p[^>]*truncate[^>]*>([^<]+)<\/p>/);

        if (hrefMatch) {
            const epNum = epNumMatch ? parseInt(epNumMatch[1].trim(), 10) : episodes.length + 1;
            const epTitle = epTitleMatch ? epTitleMatch[1].trim() : `Episode ${epNum}`;
            
            episodes.push({
                title: epTitle,
                href: "https://itachi.tv" + hrefMatch[1],
                number: epNum,
                season: 1
            });
        }
    }

    return JSON.stringify(episodes);
}

async function extractStreamUrl(url) {
    const res = await fetch(url);
    const html = await res.text();

    // Locate the Anilink iframe embedded in the player page
    const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/);
    
    if (iframeMatch) {
        // Clean the extracted URL by unescaping HTML entities
        const iframeUrl = iframeMatch[1].replace(/&amp;/g, '&');

        try {
            // Fetch the iframe directly to scrape the raw video file
            const iframeRes = await fetch(iframeUrl);
            const iframeHtml = await iframeRes.text();

            // Search the iframe's source code for the raw .m3u8 streaming link
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
    
    // Return none if extraction fails so Shirox knows to stop spinning
    return JSON.stringify({ type: "none" });
}
