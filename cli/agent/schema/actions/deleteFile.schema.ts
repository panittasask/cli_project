import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const DeleteFileActionSchema = z.object({
    action: z.literal("delete_file"),
    path: NonEmptyStringSchema,
    ...ActionMetadataSchema
}).strict();

export type DeleteFileAction = z.infer<typeof DeleteFileActionSchema>;

module.exports = { DeleteFileActionSchema };
