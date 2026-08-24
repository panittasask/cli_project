import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const McpCallActionSchema = z.object({
    action: z.literal("mcp_call_tool"),
    server: z.string(),
    tool: z.string(),
    arguments: z.record(z.unknown()),
    ...ActionMetadataSchema
}).strict();

export type McpCallAction = z.infer<typeof McpCallActionSchema>;

module.exports = { McpCallActionSchema };
