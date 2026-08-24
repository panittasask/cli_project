import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const SearchProjectActionSchema = z.object({
    action: z.literal("search_project"),
    query: z.string(),
    path: z.string().optional(),
    limit: z.number().int().min(1).max(30).optional(),
    ...ActionMetadataSchema
}).strict();

export type SearchProjectAction = z.infer<typeof SearchProjectActionSchema>;

module.exports = { SearchProjectActionSchema };
