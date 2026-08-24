export type ToolContext = {
    workspacePath: string;
    sessionId?: string;
};

export type ToolResult<T = unknown> = {
    success: boolean;
    data?: T;
    error?: string;
};

export interface Tool<TInput = unknown, TOutput = unknown> {
    readonly name: string;
    execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}
