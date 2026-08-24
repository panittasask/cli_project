import z = require("zod");
const { AgentTaskContractSchema } = require("../taskContract.schema");
const { ActionReasonSchema } = require("./shared.schema");

const RefineTaskActionSchema = z.object({
    action: z.literal("refine_task"),
    task: AgentTaskContractSchema,
    evidence: z.array(z.string()).min(1).max(8),
    ...ActionReasonSchema
}).strict();

export type RefineTaskAction = z.infer<typeof RefineTaskActionSchema>;

module.exports = { RefineTaskActionSchema };
