import z = require("zod");
const { OptionalActionMetadataSchema } = require("./shared.schema");

const FinalActionSchema = z.object({
    action: z.literal("final"),
    answer: z.string(),
    completion_status: z.enum(["completed", "already_satisfied", "no_change_needed", "incomplete"]).default("completed"),
    evidence: z.array(z.string()).max(8).default([]),
    ...OptionalActionMetadataSchema
}).strict();

export type FinalAction = z.infer<typeof FinalActionSchema>;

module.exports = { FinalActionSchema };
