import fs = require("node:fs");
import path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as {
    Client: new (info: { name: string; version: string }) => McpClient;
};
const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/sdk/client/stdio.js") as {
    StdioClientTransport: new (options: StdioOptions) => McpTransport;
    getDefaultEnvironment: () => Record<string, string>;
};

type JsonObject = Record<string, unknown>;

type McpServerConfig = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
};

type McpToolDefinition = {
    name: string;
    description?: string;
    inputSchema?: unknown;
};

type StdioOptions = {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stderr?: "inherit";
};

type McpTransport = {
    onclose?: () => void;
};

type McpClient = {
    onclose?: () => void;
    connect: (transport: McpTransport) => Promise<void>;
    close: () => Promise<void>;
    listTools: () => Promise<{ tools: McpToolDefinition[] }>;
    callTool: (input: { name: string; arguments?: JsonObject }) => Promise<unknown>;
    getInstructions?: () => string | undefined;
};

type McpConnection = {
    client: McpClient;
    fingerprint: string;
};

class McpTool {
    private readonly connections = new Map<string, McpConnection>();
    private readonly toolOwners = new Map<string, string | null>();

    resolveDirectCall(toolName: string, payload: JsonObject): { server: string; tool: string; arguments: JsonObject } | undefined {
        let normalizedToolName = toolName;
        let serverName = this.toolOwners.get(toolName);

        if (!serverName && toolName.includes(".")) {
            const separator = toolName.indexOf(".");
            const explicitServer = toolName.slice(0, separator);
            const explicitTool = toolName.slice(separator + 1);
            if (this.toolOwners.get(explicitTool) === explicitServer) {
                serverName = explicitServer;
                normalizedToolName = explicitTool;
            }
        }

        if (!serverName) {
            return undefined;
        }

        const { action: _action, ...args } = payload;
        return { server: serverName, tool: normalizedToolName, arguments: args };
    }

    async buildPromptSection(): Promise<string> {
        const configs = this.loadConfig();
        const serverNames = Object.keys(configs);

        if (serverNames.length === 0) {
            return `MCP server convention:
- Create MCP servers under mcp/servers/<server-name>/.
- Register stdio servers in .cli/mcp.json using this shape:
  {"mcpServers":{"name":{"command":"node","args":["mcp/servers/name/server.mjs"],"cwd":"."}}}
- After writing the server and config, use mcp_list_tools to verify discovery, then mcp_call_tool to invoke it.`;
        }

        const sections: string[] = [];
        for (const serverName of serverNames) {
            try {
                const { tools, instructions } = await this.listServerTools(serverName);
                const renderedTools = tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description || "",
                    inputSchema: tool.inputSchema || {}
                }));
                sections.push(`Server ${serverName}: ${JSON.stringify(renderedTools)}${instructions ? `\nInstructions: ${instructions}` : ""}`);
            } catch (error) {
                sections.push(`Server ${serverName}: connection error: ${this.errorMessage(error)}`);
            }
        }

        return `MCP servers are configured in .cli/mcp.json.
Create project-local servers under mcp/servers/<server-name>/ and register them in that config.
Discovered MCP tools:
${sections.join("\n")}`;
    }

    async listTools(serverName?: string): Promise<string> {
        const configs = this.loadConfig();
        const names = serverName ? [serverName] : Object.keys(configs);
        if (names.length === 0) {
            return JSON.stringify({ servers: [], message: "No MCP servers configured in .cli/mcp.json." });
        }

        const servers: Array<Record<string, unknown>> = [];
        for (const name of names) {
            if (!configs[name]) {
                servers.push({ name, error: `Unknown MCP server: ${name}` });
                continue;
            }

            try {
                const result = await this.listServerTools(name);
                servers.push({ name, tools: result.tools, instructions: result.instructions });
            } catch (error) {
                servers.push({ name, error: this.errorMessage(error) });
            }
        }

        return JSON.stringify({ servers });
    }

    async callTool(serverName: string, toolName: string, args: JsonObject): Promise<string> {
        if (!serverName.trim() || !toolName.trim()) {
            throw new Error("MCP server and tool names are required.");
        }

        const { client } = await this.getConnection(serverName);
        const result = await client.callTool({ name: toolName, arguments: args });
        if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
            const content = (result as { content?: unknown }).content;
            throw new Error(`MCP tool ${serverName}.${toolName} failed: ${JSON.stringify(content)}`);
        }
        return JSON.stringify(result);
    }

    async close(): Promise<void> {
        const pending = Array.from(this.connections.values()).map(({ client }) => client.close().catch(() => undefined));
        this.connections.clear();
        await Promise.all(pending);
    }

    private async listServerTools(serverName: string): Promise<{ tools: McpToolDefinition[]; instructions?: string }> {
        const { client } = await this.getConnection(serverName);
        const result = await client.listTools();
        for (const tool of result.tools) {
            const existingOwner = this.toolOwners.get(tool.name);
            if (existingOwner === undefined) {
                this.toolOwners.set(tool.name, serverName);
            } else if (existingOwner !== serverName) {
                this.toolOwners.set(tool.name, null);
            }
        }
        const instructions = client.getInstructions?.();
        return instructions ? { tools: result.tools, instructions } : { tools: result.tools };
    }

    private async getConnection(serverName: string): Promise<McpConnection> {
        const configs = this.loadConfig();
        const config = configs[serverName];
        if (!config) {
            throw new Error(`Unknown MCP server: ${serverName}`);
        }

        const fingerprint = JSON.stringify(config);
        const cached = this.connections.get(serverName);
        if (cached?.fingerprint === fingerprint) {
            return cached;
        }

        if (cached) {
            await cached.client.close().catch(() => undefined);
            this.connections.delete(serverName);
        }

        const client = new Client({ name: "local-agent-cli", version: "1.0.0" });
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: { ...getDefaultEnvironment(), ...config.env },
            stderr: "inherit"
        });
        const connection = { client, fingerprint };
        client.onclose = () => this.connections.delete(serverName);
        await client.connect(transport);
        this.connections.set(serverName, connection);
        return connection;
    }

    private loadConfig(): Record<string, McpServerConfig> {
        const configPath = path.resolve(process.cwd(), ".cli", "mcp.json");
        if (!fs.existsSync(configPath)) {
            return {};
        }

        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers?: unknown };
        if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
            throw new Error("Invalid .cli/mcp.json: mcpServers must be an object.");
        }

        const configs: Record<string, McpServerConfig> = {};
        for (const [name, rawValue] of Object.entries(parsed.mcpServers as Record<string, unknown>)) {
            if (!rawValue || typeof rawValue !== "object") {
                throw new Error(`Invalid MCP config for ${name}.`);
            }

            const raw = rawValue as Record<string, unknown>;
            if (typeof raw.command !== "string" || !raw.command.trim()) {
                throw new Error(`MCP server ${name} is missing command.`);
            }

            const args = raw.args === undefined ? [] : this.stringArray(raw.args, `${name}.args`);
            const env = raw.env === undefined ? {} : this.stringRecord(raw.env, `${name}.env`);
            const cwdInput = typeof raw.cwd === "string" ? raw.cwd : ".";
            const cwd = this.resolveInsideWorkspace(cwdInput);
            configs[name] = { command: raw.command, args, cwd, env };
        }

        return configs;
    }

    private resolveInsideWorkspace(inputPath: string): string {
        const workspace = process.cwd();
        const resolved = path.resolve(workspace, inputPath);
        const relative = path.relative(workspace, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`MCP cwd is outside workspace: ${inputPath}`);
        }
        return resolved;
    }

    private stringArray(value: unknown, field: string): string[] {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
            throw new Error(`Invalid MCP config: ${field} must be a string array.`);
        }
        return value as string[];
    }

    private stringRecord(value: unknown, field: string): Record<string, string> {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`Invalid MCP config: ${field} must be an object.`);
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.some(([, item]) => typeof item !== "string")) {
            throw new Error(`Invalid MCP config: ${field} values must be strings.`);
        }
        return Object.fromEntries(entries) as Record<string, string>;
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

module.exports = { McpTool };
