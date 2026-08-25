import z = require("zod");
const { NonEmptyStringSchema, NonBlankPreservedStringSchema, OptionalActionMetadataSchema } = require("./shared.schema");

const FinalActionSchema = z.object({
    action: z.literal("final"),
    answer: NonBlankPreservedStringSchema,
    completion_status: z.enum(["completed", "already_satisfied", "no_change_needed", "incomplete"]).default("completed"),
    evidence: z.array(NonEmptyStringSchema).max(8).default([]),
    ...OptionalActionMetadataSchema
}).strict();

export type FinalAction = z.infer<typeof FinalActionSchema>;

module.exports = { FinalActionSchema };
