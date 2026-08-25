import z = require("zod");

const NonEmptyStringSchema = z.string().trim().min(1);
const NonBlankPreservedStringSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "String must contain at least one non-whitespace character"
});

module.exports = { NonEmptyStringSchema, NonBlankPreservedStringSchema };
