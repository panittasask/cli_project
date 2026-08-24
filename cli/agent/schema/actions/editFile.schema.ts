import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const EditFileActionSchema = z.object({
    action: z.literal("edit_file"),
    path: z.string(),
    old_text: z.string(),
    new_text: z.string(),
    ...ActionMetadataSchema
}).strict();

export type EditFileAction = z.infer<typeof EditFileActionSchema>;

module.exports = { EditFileActionSchema };
