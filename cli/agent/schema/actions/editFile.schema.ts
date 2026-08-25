import z = require("zod");
const { ActionMetadataSchema, NonBlankPreservedStringSchema, NonEmptyStringSchema } = require("./shared.schema");

const EditFileActionSchema = z.object({
    action: z.literal("edit_file"),
    path: NonEmptyStringSchema,
    old_text: NonBlankPreservedStringSchema,
    new_text: z.string(),
    ...ActionMetadataSchema
}).strict();

export type EditFileAction = z.infer<typeof EditFileActionSchema>;

module.exports = { EditFileActionSchema };
