import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const ReadFileActionSchema = z.object({
    action: z.literal("read_file"),
    path: z.string(),
    ...ActionMetadataSchema
}).strict();

export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

module.exports = { ReadFileActionSchema };
