import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dns from "node:dns/promises";
import net from "node:net";
import { runSearchPipeline } from "./searchPipeline.mjs";
import { htmlToText, searchBingHtml, searchBingRss } from "./htmlSearch.mjs";

const server = new McpServer({
    name: "web-search",
    version: "1.1.0"
}, {
    instructions: "Use search_web for current, niche, or external information. Base answers on returned snippets and cite the returned source URLs."
});

async function searchOnce(query, maxResults) {
    const [html, rss] = await Promise.all([searchBingHtml(query, maxResults), searchBingRss(query, maxResults)]);
    const gathered = new Map();
    for (const result of [...html.results, ...rss.results]) {
        if (!gathered.has(result.url)) gathered.set(result.url, result);
    }
    return { provider: "Bing HTML + RSS", results: [...gathered.values()].slice(0, maxResults * 2) };
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
