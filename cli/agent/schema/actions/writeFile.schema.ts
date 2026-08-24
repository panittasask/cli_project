import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const WriteFileActionSchema = z.object({
    action: z.literal("write_file"),
    path: z.string(),
    content: z.string(),
    ...ActionMetadataSchema
}).strict();

export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

module.exports = { WriteFileActionSchema };
