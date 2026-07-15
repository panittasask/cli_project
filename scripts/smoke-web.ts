const { McpTool } = require("../cli/tools/mcpTool") as { McpTool: new () => {
    callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
    close: () => Promise<void>;
} };

async function main(): Promise<void> {
    const mcp = new McpTool();
    try {
        const raw = await mcp.callTool("web-search", "search_web", {
            query: process.argv.slice(2).join(" ") || "Meme 67 origin meaning TikTok",
            maxResults: 5
        });
        const envelope = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> };
        const text = envelope.content?.find((item) => item.type === "text")?.text ?? "{}";
        const payload = JSON.parse(text) as {
            resultCount?: number;
            evidenceQuality?: string;
            attempts?: unknown[];
            results?: Array<{ url?: string }>;
        };
        const firstSource = payload.results?.find((result) => result.url)?.url;
        let openedPage: { url?: string; content?: string } | undefined;
        if (firstSource) {
            const openRaw = await mcp.callTool("web-search", "open_web_page", { url: firstSource });
            const openEnvelope = JSON.parse(openRaw) as { content?: Array<{ type?: string; text?: string }> };
            const openText = openEnvelope.content?.find((item) => item.type === "text")?.text ?? "{}";
            openedPage = JSON.parse(openText) as { url?: string; content?: string };
        }
        console.log(JSON.stringify({
            resultCount: payload.resultCount,
            evidenceQuality: payload.evidenceQuality,
            attempts: payload.attempts,
            sources: payload.results?.map((result) => result.url),
            openedSource: openedPage?.url,
            openedContentChars: openedPage?.content?.length ?? 0
        }, null, 2));
        if (payload.evidenceQuality !== "sufficient" || (payload.resultCount ?? 0) < 2 || (openedPage?.content?.length ?? 0) < 100) process.exitCode = 2;
    } finally {
        await mcp.close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
