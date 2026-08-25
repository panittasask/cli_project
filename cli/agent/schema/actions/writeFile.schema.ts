import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const WriteFileActionSchema = z.object({
    action: z.literal("write_file"),
    path: NonEmptyStringSchema,
    content: z.string(),
    ...ActionMetadataSchema
}).strict();

export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

module.exports = { WriteFileActionSchema };
