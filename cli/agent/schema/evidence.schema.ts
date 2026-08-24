import z = require("zod");

const EvidenceKindSchema = z.enum(["source", "command", "runtime", "interaction", "visual"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

module.exports = { EvidenceKindSchema };
