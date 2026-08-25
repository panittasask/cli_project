import z = require("zod");
const { ActionMetadataSchema, NonEmptyStringSchema } = require("./shared.schema");

const ClarificationOptionSchema = z.object({
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    description: z.string().optional()
}).strict();

const AskUserActionSchema = z.object({
    action: z.literal("ask_user"),
    question: NonEmptyStringSchema,
    options: z.array(ClarificationOptionSchema).min(2).max(6),
    decision: z.enum(["target", "scope", "compatibility", "destructive", "cost", "external", "preference"]),
    ...ActionMetadataSchema
}).strict();

export type AskUserAction = z.infer<typeof AskUserActionSchema>;

module.exports = { AskUserActionSchema, ClarificationOptionSchema };
