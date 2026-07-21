export function htmlToText(value) {
    return String(value || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function attributeValue(markup, name) {
    const match = markup.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    return match?.[2]?.trim() || "";
}

function resolveResultUrl(rawUrl) {
    const decoded = String(rawUrl || "").replace(/&amp;/gi, "&");
    try {
        const url = new URL(decoded);
        if (!/(^|\.)bing\.com$/i.test(url.hostname)) return url.toString();
        const encodedTarget = url.searchParams.get("u") || "";
        if (!encodedTarget.startsWith("a1")) return "";
        const target = Buffer.from(encodedTarget.slice(2), "base64url").toString("utf8");
        return /^https?:\/\//i.test(target) ? target : "";
    } catch {
        return "";
    }
}

export function extractBingSearchResults(html, maxResults) {
    const results = [];
    const blocks = String(html || "").matchAll(/<li\b[^>]*class=(["'])[^"']*\bb_algo\b[^"']*\1[^>]*>([\s\S]*?)<\/li>/gi);

    for (const block of blocks) {
        const content = block[2] || "";
        const heading = content.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "";
        const anchor = heading.match(/<a\b[^>]*>/i)?.[0] || "";
        const url = resolveResultUrl(attributeValue(anchor, "href"));
        if (!/^https?:\/\//i.test(url)) continue;

        const caption = content.match(/<div\b[^>]*class=(["'])[^"']*\bb_caption\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]
            || content.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
            || "";
        try {
            results.push({
                rank: results.length + 1,
                title: htmlToText(heading),
                snippet: htmlToText(caption),
                url,
                source: new URL(url).hostname
            });
        } catch {
            // Ignore malformed or non-public-looking result links.
        }
        if (results.length >= maxResults) break;
    }

    return results;
}

function decodeDuckDuckGoUrl(rawUrl) {
    const value = String(rawUrl || "").replace(/&amp;/gi, "&").trim();
    try {
        const url = new URL(value, "https://duckduckgo.com");
        if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith("/l/")) {
            return url.searchParams.get("uddg") || "";
        }
        return /^https?:\/\//i.test(url.toString()) ? url.toString() : "";
    } catch {
        return "";
    }
}

export function extractDuckDuckGoSearchResults(html, maxResults) {
    const results = [];
    const blocks = String(html || "").matchAll(/<div\b[^>]*class=(["'])[^"']*\bresult\b[^"']*\1[^>]*>([\s\S]*?)(?=<div\b[^>]*class=(["'])[^"']*\bresult\b|$)/gi);
    for (const block of blocks) {
        const content = block[2] || "";
        const anchor = content.match(/<a\b[^>]*class=(["'])[^"']*\bresult__a\b[^"']*\1[^>]*>/i)?.[0] || "";
        const url = decodeDuckDuckGoUrl(attributeValue(anchor, "href"));
        if (!/^https?:\/\//i.test(url)) continue;
        const title = content.match(/<a\b[^>]*class=(["'])[^"']*\bresult__a\b[^"']*\1[^>]*>([\s\S]*?)<\/a>/i)?.[2] || "";
        const snippet = content.match(/<[^>]*class=(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\//i)?.[2] || "";
        results.push({ rank: results.length + 1, title: htmlToText(title), snippet: htmlToText(snippet), url, source: new URL(url).hostname });
        if (results.length >= maxResults) break;
    }
    return results;
}

export async function searchDuckDuckGoHtml(query, maxResults, request = fetch) {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const response = await request(url, {
        headers: {
            "accept": "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`DuckDuckGo HTML returned HTTP ${response.status}`);
    return { provider: "DuckDuckGo HTML", results: extractDuckDuckGoSearchResults(await response.text(), maxResults) };
}

export async function searchBingHtml(query, maxResults, request = fetch) {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("setlang", "en-US");
    url.searchParams.set("cc", "US");
    const response = await request(url, {
        headers: {
            "accept": "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Bing HTML returned HTTP ${response.status}`);

    return {
        provider: "Bing HTML",
        results: extractBingSearchResults(await response.text(), maxResults)
    };
}

function readRssField(item, field) {
    const match = item.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, "i"));
    return htmlToText((match?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

export async function searchBingRss(query, maxResults, request = fetch) {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("format", "rss");
    url.searchParams.set("q", query);
    const response = await request(url, {
        headers: { "user-agent": "Mozilla/5.0 local-agent-cli/1.0" },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Bing RSS returned HTTP ${response.status}`);

    const results = [];
    for (const match of (await response.text()).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const url = readRssField(match[1] || "", "link");
        try {
            results.push({
                rank: results.length + 1,
                title: readRssField(match[1] || "", "title"),
                snippet: readRssField(match[1] || "", "description"),
                url,
                source: new URL(url).hostname
            });
        } catch {
            // Skip malformed feed entries.
        }
        if (results.length >= maxResults) break;
    }
    return { provider: "Bing RSS", results };
}
