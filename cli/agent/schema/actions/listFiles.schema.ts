import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const ListFilesActionSchema = z.object({
    action: z.literal("list_files"),
    path: z.string().optional(),
    ...ActionMetadataSchema
}).strict();

export type ListFilesAction = z.infer<typeof ListFilesActionSchema>;

module.exports = { ListFilesActionSchema };
