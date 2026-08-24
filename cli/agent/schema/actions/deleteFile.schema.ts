import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const DeleteFileActionSchema = z.object({
    action: z.literal("delete_file"),
    path: z.string(),
    ...ActionMetadataSchema
}).strict();

export type DeleteFileAction = z.infer<typeof DeleteFileActionSchema>;

module.exports = { DeleteFileActionSchema };
