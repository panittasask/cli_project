import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const ReadFileActionSchema = z.object({
    action: z.literal("read_file"),
    path: NonEmptyStringSchema,
    ...ActionMetadataSchema
}).strict();

export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

module.exports = { ReadFileActionSchema };
