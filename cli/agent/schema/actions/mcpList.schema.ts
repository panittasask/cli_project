import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const McpListActionSchema = z.object({
    action: z.literal("mcp_list_tools"),
    server: z.string().optional(),
    ...ActionMetadataSchema
}).strict();

export type McpListAction = z.infer<typeof McpListActionSchema>;

module.exports = { McpListActionSchema };
