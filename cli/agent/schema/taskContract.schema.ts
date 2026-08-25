import z = require("zod");
const { WorkflowKindSchema, VerificationKindSchema } = require("./verification.schema");
const { EvidenceKindSchema } = require("./evidence.schema");
const { NonBlankPreservedStringSchema } = require("./nonEmptyString.schema");

const AgentTaskContractSchema = z.object({
    intent: NonBlankPreservedStringSchema,
    task_type: WorkflowKindSchema,
    continuation: z.boolean(),
    requires_workspace_changes: z.boolean(),
    verification: VerificationKindSchema,
    evidence_requirements: z.array(EvidenceKindSchema).min(1).max(5),
    success_criteria: z.array(NonBlankPreservedStringSchema).min(1).max(6)
}).strict();

export type AgentTaskContract = z.infer<typeof AgentTaskContractSchema>;

module.exports = { AgentTaskContractSchema };
