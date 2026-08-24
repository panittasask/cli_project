import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const SearchFilesActionSchema = z.object({
    action: z.literal("search_files"),
    query: z.string(),
    path: z.string().optional(),
    ...ActionMetadataSchema
}).strict();

export type SearchFilesAction = z.infer<typeof SearchFilesActionSchema>;

module.exports = { SearchFilesActionSchema };
