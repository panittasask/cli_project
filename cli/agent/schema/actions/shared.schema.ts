import z = require("zod");
const { AgentTaskContractSchema } = require("../taskContract.schema");
const { NonEmptyStringSchema, NonBlankPreservedStringSchema } = require("../nonEmptyString.schema");

const OptionalActionMetadataSchema = {
    reason: z.string().optional(),
    task: AgentTaskContractSchema.optional()
};

const ActionMetadataSchema = {
    reason: z.string().optional(),
    task: AgentTaskContractSchema.optional()
};

const ActionReasonSchema = {
    reason: z.string().optional()
};

module.exports = {
    NonEmptyStringSchema,
    NonBlankPreservedStringSchema,
    OptionalActionMetadataSchema,
    ActionMetadataSchema,
    ActionReasonSchema
};
