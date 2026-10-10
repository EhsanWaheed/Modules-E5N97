async function searchResults(query) {
    const searchUrl = `https://itachi.tv/search?q=${encodeURIComponent(query)}`;
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
                // Next.js encodes the original image URL, so we decode it here for the app
                imgUrl = decodeURIComponent(imgMatch[1]);
            }
            
            results.push({
                name: titleMatch[1],
                url: "https://itachi.tv" + hrefMatch[1],
                image: imgUrl
            });
        }
    }
    
    return results;
}

async function info(url) {
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
            const epNum = epNumMatch ? epNumMatch[1].trim() : "";
            const epTitle = epTitleMatch ? epTitleMatch[1].trim() : `Episode ${epNum}`;
            
            episodes.push({
                title: `${epNum} - ${epTitle}`,
                url: "https://itachi.tv" + hrefMatch[1]
            });
        }
    }

    return {
        episodes: episodes
    };
}

async function stream(url) {
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
                return [{
                    url: fileMatch[1],
                    quality: "Auto",
                    isHLS: true
                }];
            }
        } catch (e) {
            console.error("Failed to parse iframe:", e);
        }

        // Fallback: If raw extraction fails, hand the iframe URL to the app
        return [{
            url: iframeUrl,
            quality: "Unknown",
            isIframe: true
        }];
    }
    
    return [];
}
