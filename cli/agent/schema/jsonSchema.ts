import z = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema") as {
    zodToJsonSchema: (schema: z.ZodTypeAny, options?: Record<string, unknown>) => Record<string, unknown>;
};

function convertZodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
    const generated = zodToJsonSchema(schema, {
        target: "jsonSchema7",
        $refStrategy: "none"
    });
    const { $schema: _schema, ...jsonSchema } = generated;
    return jsonSchema;
}

module.exports = { convertZodToJsonSchema };
