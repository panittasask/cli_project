import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

const { McpTool } = require("../cli/tools/mcpTool") as { McpTool: new (configRoot?: string) => {
    listTools: (serverName?: string) => Promise<string>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
    close: () => Promise<void>;
} };

async function main(): Promise<void> {
    const appRoot = process.cwd();
    const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-mcp-workspace-"));
    process.chdir(emptyWorkspace);
    const mcp = new McpTool(appRoot);

    try {
        const listed = JSON.parse(await mcp.listTools("example")) as {
            servers?: Array<{ tools?: Array<{ name?: string }> }>;
        };
        const hasEcho = listed.servers?.[0]?.tools?.some((tool) => tool.name === "echo") === true;
        if (!hasEcho) {
            throw new Error("The example.echo MCP tool was not discovered.");
        }

        const webTools = JSON.parse(await mcp.listTools("web-search")) as {
            servers?: Array<{ tools?: Array<{ name?: string }> }>;
        };
        const webToolNames = webTools.servers?.[0]?.tools?.map((tool) => tool.name) ?? [];
        if (!webToolNames.includes("search_web") || !webToolNames.includes("open_web_page")) {
            throw new Error(`Web tools were not discovered: ${webToolNames.join(", ")}`);
        }

        const called = JSON.parse(await mcp.callTool("example", "echo", { text: "MCP test passed" })) as {
            content?: Array<{ type?: string; text?: string }>;
        };
        const text = called.content?.find((item) => item.type === "text")?.text;
        if (text !== "MCP echo: MCP test passed") {
            throw new Error(`Unexpected MCP result: ${text || "empty"}`);
        }

        console.log("MCP discovery, web capability manifest, and example tool call passed.");
    } finally {
        await mcp.close();
        process.chdir(appRoot);
        fs.rmSync(emptyWorkspace, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
