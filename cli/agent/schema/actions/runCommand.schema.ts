import z = require("zod");
const { ActionMetadataSchema } = require("./shared.schema");

const CommandExpectationSchema = z.object({
    exit_code: z.literal(0).optional(),
    output_includes: z.array(z.string()).max(8).optional(),
    output_excludes: z.array(z.string()).max(8).optional()
}).strict();

export type CommandExpectation = z.infer<typeof CommandExpectationSchema>;

const RunCommandActionSchema = z.object({
    action: z.literal("run_command"),
    command: z.string(),
    workdir: z.string().optional(),
    mode: z.enum(["normal", "probe"]).optional(),
    timeout_ms: z.number().int().min(1000).max(30000).optional(),
    expect: CommandExpectationSchema.optional(),
    ...ActionMetadataSchema
}).strict();

export type RunCommandAction = z.infer<typeof RunCommandActionSchema>;

module.exports = { CommandExpectationSchema, RunCommandActionSchema };
