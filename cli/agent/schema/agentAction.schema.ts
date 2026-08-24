import z = require("zod");
const { FinalActionSchema } = require("./actions/final.schema");
const { ListFilesActionSchema } = require("./actions/listFiles.schema");
const { SearchFilesActionSchema } = require("./actions/searchFiles.schema");
const { SearchProjectActionSchema } = require("./actions/searchProject.schema");
const { ReadFileActionSchema } = require("./actions/readFile.schema");
const { WriteFileActionSchema } = require("./actions/writeFile.schema");
const { EditFileActionSchema } = require("./actions/editFile.schema");
const { DeleteFileActionSchema } = require("./actions/deleteFile.schema");
const { RunCommandActionSchema, CommandExpectationSchema } = require("./actions/runCommand.schema");
const { RefineTaskActionSchema } = require("./actions/refineTask.schema");
const { AskUserActionSchema } = require("./actions/askUser.schema");
const { McpListActionSchema } = require("./actions/mcpList.schema");
const { McpCallActionSchema } = require("./actions/mcpCall.schema");

const AgentActionSchemas = {
    final: FinalActionSchema,
    list_files: ListFilesActionSchema,
    search_files: SearchFilesActionSchema,
    search_project: SearchProjectActionSchema,
    read_file: ReadFileActionSchema,
    write_file: WriteFileActionSchema,
    edit_file: EditFileActionSchema,
    delete_file: DeleteFileActionSchema,
    run_command: RunCommandActionSchema,
    refine_task: RefineTaskActionSchema,
    ask_user: AskUserActionSchema,
    mcp_list_tools: McpListActionSchema,
    mcp_call_tool: McpCallActionSchema
} as const;

const actionSchemas = Object.values(AgentActionSchemas) as unknown as [z.ZodDiscriminatedUnionOption<"action">, ...z.ZodDiscriminatedUnionOption<"action">[]];
const AgentActionSchema = z.discriminatedUnion("action", actionSchemas);
export type AgentAction =
    | import("./actions/final.schema").FinalAction
    | import("./actions/listFiles.schema").ListFilesAction
    | import("./actions/searchFiles.schema").SearchFilesAction
    | import("./actions/searchProject.schema").SearchProjectAction
    | import("./actions/readFile.schema").ReadFileAction
    | import("./actions/writeFile.schema").WriteFileAction
    | import("./actions/editFile.schema").EditFileAction
    | import("./actions/deleteFile.schema").DeleteFileAction
    | import("./actions/runCommand.schema").RunCommandAction
    | import("./actions/refineTask.schema").RefineTaskAction
    | import("./actions/askUser.schema").AskUserAction
    | import("./actions/mcpList.schema").McpListAction
    | import("./actions/mcpCall.schema").McpCallAction;

module.exports = { AgentActionSchemas, AgentActionSchema, CommandExpectationSchema };
