import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const McpCallActionSchema = z.object({
    action: z.literal("mcp_call_tool"),
    server: NonEmptyStringSchema,
    tool: NonEmptyStringSchema,
    arguments: z.record(z.unknown()),
    ...ActionMetadataSchema
}).strict();

export type McpCallAction = z.infer<typeof McpCallActionSchema>;

module.exports = { McpCallActionSchema };
