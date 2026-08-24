import z = require("zod");

const WorkflowKindSchema = z.enum(["general", "web_research", "coding", "mcp_creation"]);
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

const VerificationKindSchema = z.enum(["none", "command", "runtime", "interaction"]);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

module.exports = { WorkflowKindSchema, VerificationKindSchema };
