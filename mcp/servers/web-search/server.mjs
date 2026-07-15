import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import DDG from "duck-duck-scrape";
import dns from "node:dns/promises";
import net from "node:net";
import { runSearchPipeline } from "./searchPipeline.mjs";

const server = new McpServer({
    name: "web-search",
    version: "1.0.0"
}, {
    instructions: "Use search_web for current, niche, or external information. Base answers on returned snippets and cite the returned source URLs."
});

function cleanText(value) {
    return String(value || "")
        .replace(/<\/?b>/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeXml(value) {
    return cleanText(String(value || "")
        .replace(/^<!\[CDATA\[|\]\]>$/g, "")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/<[^>]+>/g, " "));
}

function readXmlField(item, field) {
    const match = item.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, "i"));
    return decodeXml(match?.[1] || "");
}

async function searchBingRss(query, maxResults) {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("format", "rss");
    url.searchParams.set("q", query);
    const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 local-agent-cli/1.0" },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
        throw new Error(`Bing RSS returned HTTP ${response.status}`);
    }

    const xml = await response.text();
    return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi))
        .slice(0, maxResults)
        .map((match, index) => {
            const resultUrl = readXmlField(match[1], "link");
            let source = "";
            try {
                source = new URL(resultUrl).hostname;
            } catch {
                source = "unknown";
            }
            return {
                rank: index + 1,
                title: readXmlField(match[1], "title"),
                snippet: readXmlField(match[1], "description"),
                url: resultUrl,
                source
            };
        });
}

async function searchOnce(query, maxResults) {
    try {
        const response = await DDG.search(query, {
            safeSearch: DDG.SafeSearchType.MODERATE,
            locale: "th-th",
            region: "th-en",
            marketRegion: "TH"
        });
        return {
            provider: "DuckDuckGo",
            results: response.results.slice(0, maxResults).map((result, index) => ({
                rank: index + 1,
                title: cleanText(result.title),
                snippet: cleanText(result.description),
                url: result.url,
                source: result.hostname
            }))
        };
    } catch (duckDuckGoError) {
        const results = await searchBingRss(query, maxResults);
        return { provider: "Bing RSS fallback", results, fallbackReason: duckDuckGoError instanceof Error ? duckDuckGoError.message : String(duckDuckGoError) };
    }
}

function isPrivateAddress(address) {
    if (net.isIP(address) === 4) {
        const octets = address.split(".").map(Number);
        return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
            (octets[0] === 169 && octets[1] === 254) ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168);
    }
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

async function assertPublicUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (![/^https:$/.test(url.protocol), /^http:$/.test(url.protocol)].some(Boolean)) throw new Error("Only HTTP(S) URLs are allowed.");
    if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private or local network URLs are blocked.");
    return url;
}

function htmlToText(html) {
    return cleanText(html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "));
}

async function openPublicPage(rawUrl) {
    let current = await assertPublicUrl(rawUrl);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
        const response = await fetch(current, {
            redirect: "manual",
            headers: { "user-agent": "Mozilla/5.0 local-agent-cli/1.0" },
            signal: AbortSignal.timeout(15000)
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
            current = await assertPublicUrl(new URL(response.headers.get("location"), current).toString());
            continue;
        }
        if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
        const text = htmlToText((await response.text()).slice(0, 1_000_000));
        return { url: current.toString(), content: text.slice(0, 12000), truncated: text.length > 12000 };
    }
    throw new Error("Too many redirects.");
}

server.registerTool("search_web", {
    title: "Search the web",
    description: "Searches the public web and returns titles, snippets, and source URLs. Use for external, niche, or time-sensitive facts. Search for meaning/origin/context when explaining memes or slang.",
    inputSchema: z.object({
        query: z.string().min(2).describe("A focused web search query"),
        maxResults: z.number().int().min(1).max(10).default(5).describe("Maximum number of results")
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
    }
}, async ({ query, maxResults }) => {
    try {
        const payload = await runSearchPipeline(query, maxResults, searchOnce);
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (error) {
        return {
            isError: true,
            content: [{ type: "text", text: `Web search failed: ${error instanceof Error ? error.message : String(error)}` }]
        };
    }
});

server.registerTool("open_web_page", {
    title: "Open a public web page",
    description: "Fetches readable text from one public HTTP(S) result URL. Local/private network addresses are blocked.",
    inputSchema: z.object({ url: z.string().url() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ url }) => {
    try {
        const payload = await openPublicPage(url);
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Open page failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
