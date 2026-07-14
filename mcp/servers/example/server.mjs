import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
    name: "example",
    version: "1.0.0"
}, {
    instructions: "Use echo to verify that this project-local MCP connection works."
});

server.registerTool("echo", {
    title: "Echo text",
    description: "Returns the supplied text through MCP.",
    inputSchema: z.object({
        text: z.string().describe("Text to echo")
    })
}, async ({ text }) => ({
    content: [
        {
            type: "text",
            text: `MCP echo: ${text}`
        }
    ]
}));

const transport = new StdioServerTransport();
await server.connect(transport);
