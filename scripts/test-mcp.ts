const { McpTool } = require("../cli/tools/mcpTool") as { McpTool: new () => {
    listTools: (serverName?: string) => Promise<string>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
    close: () => Promise<void>;
} };

async function main(): Promise<void> {
    const mcp = new McpTool();

    try {
        const listed = JSON.parse(await mcp.listTools("example")) as {
            servers?: Array<{ tools?: Array<{ name?: string }> }>;
        };
        const hasEcho = listed.servers?.[0]?.tools?.some((tool) => tool.name === "echo") === true;
        if (!hasEcho) {
            throw new Error("The example.echo MCP tool was not discovered.");
        }

        const called = JSON.parse(await mcp.callTool("example", "echo", { text: "MCP test passed" })) as {
            content?: Array<{ type?: string; text?: string }>;
        };
        const text = called.content?.find((item) => item.type === "text")?.text;
        if (text !== "MCP echo: MCP test passed") {
            throw new Error(`Unexpected MCP result: ${text || "empty"}`);
        }

        console.log("MCP discovery and tool call passed.");
    } finally {
        await mcp.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
