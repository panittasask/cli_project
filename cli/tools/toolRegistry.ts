type ToolContext = import("./tool").ToolContext;
type ToolResult<T = unknown> = import("./tool").ToolResult<T>;

type RegisteredTool = {
    readonly name: string;
    execute(input: unknown, context: ToolContext): Promise<ToolResult>;
};

class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>();

    register(tool: RegisteredTool): void {
        this.tools.set(tool.name, tool);
    }

    get(name: string): RegisteredTool | undefined {
        return this.tools.get(name);
    }

    names(): string[] {
        return Array.from(this.tools.keys()).sort();
    }

    async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
        const tool = this.get(name);
        if (!tool) {
            return {
                success: false,
                error: `Unknown tool: ${name}`
            };
        }

        try {
            return await tool.execute(input, context);
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

module.exports = { ToolRegistry };
