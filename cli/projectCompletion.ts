import fs = require("node:fs");
import path = require("node:path");

type ProjectCheck = "go" | "node";

type ProjectCompletionRequirement = {
    label: string;
    requireGoModule: boolean;
    requireGoJsonApi: boolean;
    requireReactApp: boolean;
    requireAngularApp: boolean;
    forbidReactArtifacts: boolean;
    forbidAngularArtifacts: boolean;
    requireFrontendApiCall: boolean;
    requireSwagger: boolean;
    requiredChecks: ProjectCheck[];
};

const mutationPattern = /\b(create|build|make|generate|scaffold|implement|write|add|fix|finish|complete)\b|(?:สร้าง|เพิ่ม|เขียน|ทำ|แก้|ให้เสร็จ)/i;
const goPattern = /\b(golang|go\s*lang|go\s+(?:api|server|backend|rest)|gin|go-chi)\b|(?:ภาษา\s*go|โกแลง)/i;
const apiPattern = /\b(rest(?:ful|full)?|api|endpoint|backend|server)\b|(?:เอพีไอ|เซิร์ฟเวอร์)/i;
const reactPattern = /\breact(?:\.js)?\b/i;
const angularPattern = /\bangular\b/i;
const swaggerPattern = /\b(swagger|openapi)\b/i;

function inferProjectCompletionRequirement(message: string): ProjectCompletionRequirement | undefined {
    const clean = message.trim();
    if (!mutationPattern.test(clean)) return undefined;

    const wantsGo = goPattern.test(clean) && apiPattern.test(clean);
    const removesReact = /\b(?:remove|delete|uninstall)(?:\s+\w+){0,3}\s+react\b|(?:ลบ|เอาออก)\s*(?:ตัว|แพ็กเกจ|package)?\s*react\b|replace\s+react\s+with\s+angular|เปลี่ยน\s*react[\s\S]*(?:เป็น|ไปใช้)\s*angular/i.test(clean);
    const removesAngular = /\b(?:remove|delete|uninstall)(?:\s+\w+){0,3}\s+angular\b|(?:ลบ|เอาออก)\s*(?:ตัว|แพ็กเกจ|package)?\s*angular\b|replace\s+angular\s+with\s+react|เปลี่ยน\s*angular[\s\S]*(?:เป็น|ไปใช้)\s*react/i.test(clean);
    const wantsReact = reactPattern.test(clean) && !removesReact;
    const wantsAngular = angularPattern.test(clean) && !removesAngular;
    const wantsSwagger = swaggerPattern.test(clean);
    if (!wantsGo && !wantsReact && !wantsAngular && !wantsSwagger) return undefined;

    const labels = [wantsGo ? "Go API" : "", wantsReact ? "React app" : "", wantsAngular ? "Angular app" : "", wantsSwagger ? "Swagger/OpenAPI" : ""]
        .filter(Boolean);
    const requiredChecks: ProjectCheck[] = [];
    if (wantsGo) requiredChecks.push("go");
    if (wantsReact || wantsAngular) requiredChecks.push("node");

    return {
        label: labels.join(" + "),
        requireGoModule: wantsGo,
        requireGoJsonApi: wantsGo,
        requireReactApp: wantsReact,
        requireAngularApp: wantsAngular,
        forbidReactArtifacts: removesReact,
        forbidAngularArtifacts: removesAngular,
        requireFrontendApiCall: wantsGo && (wantsReact || wantsAngular),
        requireSwagger: wantsSwagger,
        requiredChecks
    };
}

function inferProjectCompletionRequirementWithHistory(
    message: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    continuation: boolean
): ProjectCompletionRequirement | undefined {
    const direct = inferProjectCompletionRequirement(message);
    if (!continuation) return direct;

    const directHasFrontend = Boolean(direct?.requireReactApp || direct?.requireAngularApp);
    if (direct?.requireGoModule && directHasFrontend) return direct;

    let combined = direct;
    let inheritedCount = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const previous = history[index];
        if (previous?.role !== "user") continue;
        const inherited = inferProjectCompletionRequirement(previous.content);
        if (!inherited) continue;
        combined = combined ? mergeProjectCompletionRequirements(combined, inherited) : inherited;
        inheritedCount += 1;
        if ((direct && inheritedCount >= 1) || (!direct && inheritedCount >= 2)) break;
    }
    return combined;
}

function mergeProjectCompletionRequirements(
    newer: ProjectCompletionRequirement,
    older: ProjectCompletionRequirement
): ProjectCompletionRequirement {
    const newerSelectsFrontend = newer.requireReactApp || newer.requireAngularApp;
    const requireReactApp = newerSelectsFrontend ? newer.requireReactApp : older.requireReactApp;
    const requireAngularApp = newerSelectsFrontend ? newer.requireAngularApp : older.requireAngularApp;
    const requireGoModule = newer.requireGoModule || older.requireGoModule;
    const requireGoJsonApi = newer.requireGoJsonApi || older.requireGoJsonApi;
    const requireSwagger = newer.requireSwagger || older.requireSwagger;
    const requiredChecks: ProjectCheck[] = [];
    if (requireGoModule) requiredChecks.push("go");
    if (requireReactApp || requireAngularApp) requiredChecks.push("node");
    const labels = [
        requireGoModule ? "Go API" : "",
        requireReactApp ? "React app" : "",
        requireAngularApp ? "Angular app" : "",
        requireSwagger ? "Swagger/OpenAPI" : ""
    ].filter(Boolean);
    return {
        label: labels.join(" + "),
        requireGoModule,
        requireGoJsonApi,
        requireReactApp,
        requireAngularApp,
        forbidReactArtifacts: newer.forbidReactArtifacts,
        forbidAngularArtifacts: newer.forbidAngularArtifacts,
        requireFrontendApiCall: requireGoModule && (requireReactApp || requireAngularApp),
        requireSwagger,
        requiredChecks
    };
}

function collectFiles(workspace: string): string[] {
    const files: string[] = [];
    const ignored = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
    const visit = (directory: string): void => {
        if (files.length >= 600) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= 600) break;
            if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile()) files.push(absolute);
        }
    };
    visit(workspace);
    return files;
}

function readText(file: string, maxChars = 100_000): string {
    try {
        const stat = fs.statSync(file);
        if (stat.size > maxChars) return "";
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) return "";
        return buffer.toString("utf8");
    } catch {
        return "";
    }
}

function evaluateProjectCompletion(
    workspace: string,
    requirement: ProjectCompletionRequirement
): string[] {
    const files = collectFiles(workspace);
    const relative = (file: string): string => path.relative(workspace, file).replace(/\\/g, "/");
    const missing: string[] = [];

    const goModules = files.filter((file) => path.basename(file).toLowerCase() === "go.mod");
    const goFiles = files.filter((file) => file.toLowerCase().endsWith(".go"));
    const goText = goFiles.map((file) => readText(file)).join("\n");

    const reactRoots: string[] = [];
    let hasReactBuildSetup = false;
    for (const packageFile of files.filter((file) => path.basename(file).toLowerCase() === "package.json")) {
        try {
            const parsed = JSON.parse(readText(packageFile)) as {
                scripts?: Record<string, unknown>;
                dependencies?: Record<string, unknown>;
                devDependencies?: Record<string, unknown>;
            };
            if (parsed.dependencies?.react || parsed.devDependencies?.react) {
                reactRoots.push(path.dirname(packageFile));
                const buildScript = typeof parsed.scripts?.build === "string" ? parsed.scripts.build : "";
                const allDependencies = { ...parsed.dependencies, ...parsed.devDependencies };
                const hasBuildDependency = ["vite", "react-scripts", "next", "webpack", "parcel"]
                    .some((dependency) => Boolean(allDependencies[dependency]));
                if (hasBuildDependency && /\b(vite|react-scripts|next|webpack|parcel)\b/i.test(buildScript)) {
                    hasReactBuildSetup = true;
                }
            }
        } catch {
            // Invalid package.json is handled by the normal write validator.
        }
    }
    const reactSources = files.filter((file) => reactRoots.some((root) => {
        const sourceRoot = path.join(root, "src");
        const rel = path.relative(sourceRoot, file);
        return !rel.startsWith("..") && !path.isAbsolute(rel) && /\.(?:js|jsx|ts|tsx)$/i.test(file);
    }));
    const reactText = reactSources.map((file) => readText(file)).join("\n");

    const angularRoots: string[] = [];
    let hasAngularBuildSetup = false;
    for (const packageFile of files.filter((file) => path.basename(file).toLowerCase() === "package.json")) {
        try {
            const parsed = JSON.parse(readText(packageFile)) as {
                scripts?: Record<string, unknown>;
                dependencies?: Record<string, unknown>;
                devDependencies?: Record<string, unknown>;
            };
            const allDependencies = { ...parsed.dependencies, ...parsed.devDependencies };
            if (allDependencies["@angular/core"]) {
                angularRoots.push(path.dirname(packageFile));
                const buildScript = typeof parsed.scripts?.build === "string" ? parsed.scripts.build : "";
                if (allDependencies["@angular/cli"] && /\bng\s+build\b/i.test(buildScript)) {
                    hasAngularBuildSetup = true;
                }
            }
        } catch {
            // Invalid package.json is handled by the normal write validator.
        }
    }
    const angularSources = files.filter((file) => angularRoots.some((root) => {
        const sourceRoot = path.join(root, "src");
        const rel = path.relative(sourceRoot, file);
        return !rel.startsWith("..") && !path.isAbsolute(rel) && /\.(?:ts|html|css|scss)$/.test(file);
    }));
    const angularText = angularSources.map((file) => readText(file)).join("\n");
    const hasAngularConfig = angularRoots.some((root) => fs.existsSync(path.join(root, "angular.json")));
    const frontendText = `${reactText}\n${angularText}`;
    const frameworkArtifactText = files
        .filter((file) => /(?:package\.json|\.(?:js|jsx|ts|tsx))$/i.test(file))
        .map((file) => readText(file))
        .join("\n");

    if (requirement.requireGoModule && goModules.length === 0) {
        missing.push("Go module manifest (go.mod)");
    }
    if (requirement.requireGoModule && goFiles.length === 0) {
        missing.push("Go application source");
    }
    if (requirement.requireGoJsonApi) {
        const hasRoute = /HandleFunc\s*\(|\.Get\s*\(|\.Post\s*\(|\.Handle\s*\(|\bGET\s+\//i.test(goText);
        const hasJson = /encoding\/json|json\.NewEncoder|application\/json/i.test(goText);
        const startsServer = /ListenAndServe\s*\(|\.Run\s*\(/i.test(goText);
        if (!hasRoute) missing.push("Go HTTP API route");
        if (!hasJson) missing.push("structured JSON API response");
        if (!startsServer) missing.push("Go HTTP server startup");
    }
    if (requirement.requireReactApp) {
        if (reactRoots.length === 0) missing.push("React package.json with a React dependency");
        if (reactSources.length === 0) missing.push("React source under src/");
        if (!hasReactBuildSetup) missing.push("React build script and build-tool dependency");
    }
    if (requirement.requireAngularApp) {
        if (angularRoots.length === 0) missing.push("Angular package.json with @angular/core");
        if (!hasAngularConfig) missing.push("Angular workspace configuration (angular.json)");
        if (angularSources.length === 0) missing.push("Angular source under src/");
        if (!hasAngularBuildSetup) missing.push("Angular build script and @angular/cli dependency");
    }
    if (requirement.forbidReactArtifacts && /react-scripts|(?:from|require\s*\()\s*[('\"]react|["']react["']\s*:/i.test(frameworkArtifactText)) {
        missing.push("remove remaining React source, scripts, and dependencies");
    }
    if (requirement.forbidAngularArtifacts && /@angular\/|\bng\s+(?:build|serve|test)\b/i.test(frameworkArtifactText)) {
        missing.push("remove remaining Angular source, scripts, and dependencies");
    }
    if (requirement.requireFrontendApiCall && !/\bfetch\s*\(|\baxios(?:\s*\(|\.)|\bHttpClient\b|\bhttp\.(?:get|post|put|delete)\s*\(/i.test(frontendText)) {
        missing.push("frontend API call using fetch, axios, or Angular HttpClient");
    }
    if (requirement.requireSwagger) {
        const namedArtifact = files.some((file) => /(?:^|\/)(?:swagger|openapi)(?:[./_-]|$)/i.test(relative(file)));
        const sourceIntegration = /swagger|openapi/i.test(goText + "\n" + frontendText);
        if (!namedArtifact && !sourceIntegration) missing.push("Swagger/OpenAPI specification or route integration");
    }

    return missing;
}

function projectChecksForCommand(command: string): ProjectCheck[] {
    const checks: ProjectCheck[] = [];
    if (/\bgo\s+(?:test|build|vet)\b/i.test(command)) checks.push("go");
    if (/\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:test|run\s+(?:build|check|lint|typecheck))\b|\bnpx(?:\.cmd)?\s+(?:tsc|vite\s+build)\b|\bng\s+(?:build|test|lint)\b/i.test(command)) {
        checks.push("node");
    }
    return checks;
}

function projectChecksAffectedByPath(filePath: string): ProjectCheck[] {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    const checks: ProjectCheck[] = [];
    if (/(?:^|\/)(?:go\.mod|go\.sum)$|\.go$/.test(normalized)) checks.push("go");
    if (/(?:^|\/)package(?:-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.(?:js|jsx|ts|tsx|css|scss|html)$/.test(normalized)) {
        checks.push("node");
    }
    return checks;
}

function formatProjectCompletionPrompt(requirement: ProjectCompletionRequirement): string {
    const items: string[] = [];
    if (requirement.requireGoModule) items.push("a go.mod and Go application source");
    if (requirement.requireGoJsonApi) items.push("an HTTP route returning structured JSON");
    if (requirement.requireReactApp) items.push("a React package.json and source under src/");
    if (requirement.requireAngularApp) items.push("an Angular package.json, angular.json, and source under src/");
    if (requirement.forbidReactArtifacts) items.push("remove old React source, scripts, and dependencies");
    if (requirement.forbidAngularArtifacts) items.push("remove old Angular source, scripts, and dependencies");
    if (requirement.requireFrontendApiCall) items.push("a real frontend API call using fetch, axios, or Angular HttpClient");
    if (requirement.requireSwagger) items.push("Swagger/OpenAPI specification or route integration");
    if (requirement.requiredChecks.includes("go")) items.push("a successful go test/build/vet command");
    if (requirement.requiredChecks.includes("node")) items.push("a successful frontend test/build/check command");
    return `Project completion profile (${requirement.label}): before final, ensure ${items.join("; ")}. Use a finite build/test command rather than a long-running development server for verification. Do not return a starter scaffold or defer required work to the user.`;
}

function formatIncompleteTaskAnswer(reasons: string[], writtenPaths: string[]): string {
    const writes = writtenPaths.length > 0 ? writtenPaths.join(", ") : "none recorded";
    return `Agent หยุดเมื่อถึงขีดจำกัด tool action ก่อนงานเสร็จ ข้อกำหนดที่ยังไม่ครบ: ${reasons.join("; ")} ไฟล์ที่บันทึกว่าแก้สำเร็จ: ${writes} ให้ทำต่อจากไฟล์ปัจจุบันและอย่าถือว่างานนี้เสร็จแล้ว`;
}

function answerDefersRequiredWork(answer: string): boolean {
    return /\b(?:basic|starter|skeleton)\b[\s\S]*\b(?:expand|extend|complete|finish|additional functionality)\b|\b(?:proceed|you can|as needed)\b[\s\S]*\b(?:expand|extend|add|implement)\b/i.test(answer);
}

module.exports = {
    answerDefersRequiredWork,
    evaluateProjectCompletion,
    formatIncompleteTaskAnswer,
    formatProjectCompletionPrompt,
    inferProjectCompletionRequirement,
    inferProjectCompletionRequirementWithHistory,
    projectChecksAffectedByPath,
    projectChecksForCommand
};
