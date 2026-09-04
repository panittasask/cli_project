type WorkflowKind = "general" | "web_research" | "coding" | "mcp_creation";
type VerificationRequirement = "none" | "command" | "runtime";
type AcceptanceEvidence = "source" | "command" | "runtime" | "interaction";

type AcceptanceContract = {
    evidence: AcceptanceEvidence;
    verification: VerificationRequirement;
    reason: string;
};

const packageVerifyCommandPattern = /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?verify(?::[\w.-]+)?\b/i;

function commandSatisfiesVerification(
    command: string,
    requirement: VerificationRequirement,
    options: { probe?: boolean } = {}
): boolean {
    if (requirement === "none") return true;
    const clean = command.toLowerCase();
    if (requirement === "runtime") {
        return /invoke-webrequest|invoke-restmethod|\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b|https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)/i.test(clean)
            || /\b(playwright|cypress|selenium|test:e2e|e2e:test)\b/i.test(clean)
            || packageVerifyCommandPattern.test(clean)
            || (options.probe === true
                && /\b(?:npm(?:\.cmd)?\s+(?:start|run\s+(?:start|dev|serve))|pnpm\s+(?:start|dev|serve)|yarn\s+(?:start|dev|serve)|bun\s+(?:start|dev|serve)|go\s+run|cargo\s+run|dotnet\s+run)\b/i.test(clean)
                || options.probe === true && /(?:^|[\s"';&|])(?:\.?[\\/])?[\w.-]+\.exe(?:$|[\s"';&|])/i.test(clean));
    }
    return /\b(test|check|verify|lint|typecheck|tsc|build|compile|go\s+test|go\s+build|cargo\s+test|pytest|unittest|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(clean);
}

function commandSatisfiesAcceptance(
    command: string,
    contract: AcceptanceContract,
    options: { probe?: boolean } = {}
): boolean {
    if (contract.evidence === "source") return true;
    if (contract.evidence === "interaction") {
        return /\b(playwright|cypress|selenium|webdriver|test:e2e|e2e:test|e2e)\b/i.test(command)
            || packageVerifyCommandPattern.test(command);
    }
    return commandSatisfiesVerification(command, contract.verification, options);
}

function workflowInstructions(kind: WorkflowKind): string {
    if (kind === "web_research") {
        return `Workflow: web research.
- Use the discovered web-search MCP tool before answering.
- Never use search_files as a substitute for internet search.
- Prefer at least two relevant sources. If evidence is weak, refine the query and search again.
- Cite exact URLs returned by successful search or page-open observations.`;
    }
    if (kind === "coding") {
        return `Workflow: coding and local files.
- Inspect relevant files before changing an existing file.
- Use search_files only for text inside this workspace.
- If the request needs external or current information, use a discovered web-search MCP tool; never substitute a local-file search for that research.
- Every write is validated automatically; fix validation failures before returning final.
- Report only checks that actually succeeded.`;
    }
    if (kind === "mcp_creation") {
        return `Workflow: MCP creation.
- Inspect the existing MCP config and server conventions first.
- Put servers under mcp/servers/<server-name> and register them in .cli/mcp.json.
- Discover the completed server with mcp_list_tools and call at least one relevant tool with mcp_call_tool before claiming success.
- Never claim an MCP server works until both checks succeed.`;
    }
    return `Workflow: general agent request.
- Decide from the current request and relevant session context whether local workspace tools are needed.
- For ordinary conversation, return final without calling tools.
- For workspace inspection or changes, use search_project, list_files, search_files, read_file, write_file, or run_command as needed.
- For external or current information, use a discovered web-search MCP tool and cite the returned source URLs.
- Do not search local files for general knowledge or use them as a substitute for web research.`;
}

module.exports = {
    commandSatisfiesVerification,
    commandSatisfiesAcceptance,
    workflowInstructions
};
