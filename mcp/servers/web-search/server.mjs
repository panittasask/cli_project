import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import DDG from "duck-duck-scrape";

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
    let duckDuckGoError = "";
    try {
        const response = await DDG.search(query, {
            safeSearch: DDG.SafeSearchType.MODERATE,
            locale: "th-th",
            region: "th-en",
            marketRegion: "TH"
        });
        const results = response.results.slice(0, maxResults).map((result, index) => ({
            rank: index + 1,
            title: cleanText(result.title),
            snippet: cleanText(result.description),
            url: result.url,
            source: result.hostname
        }));

        const payload = { query, provider: "DuckDuckGo", resultCount: results.length, results };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (error) {
        duckDuckGoError = error instanceof Error ? error.message : String(error);
    }

    try {
        const results = await searchBingRss(query, maxResults);
        const payload = { query, provider: "Bing RSS fallback", resultCount: results.length, results };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (error) {
        const bingError = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{
                type: "text",
                text: `Web search failed. DuckDuckGo: ${duckDuckGoError}. Bing RSS: ${bingError}`
            }]
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
