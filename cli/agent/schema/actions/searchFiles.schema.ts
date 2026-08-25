import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const SearchFilesActionSchema = z.object({
    action: z.literal("search_files"),
    query: NonEmptyStringSchema,
    path: z.string().optional(),
    ...ActionMetadataSchema
}).strict();

export type SearchFilesAction = z.infer<typeof SearchFilesActionSchema>;

module.exports = { SearchFilesActionSchema };
