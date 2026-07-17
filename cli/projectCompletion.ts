import fs = require("node:fs");
import path = require("node:path");

type ProjectCheck = import("./projectTypes").ProjectCheck;
type ProjectCompletionRequirement = import("./projectTypes").ProjectCompletionRequirement;

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
    return {
        label: labels.join(" + "),
        requireGoModule: wantsGo,
        requireGoJsonApi: wantsGo,
        requireReactApp: wantsReact,
        requireAngularApp: wantsAngular,
        forbidReactArtifacts: removesReact,
        forbidAngularArtifacts: removesAngular,
        requireFrontendApiCall: wantsGo && (wantsReact || wantsAngular),
        requireSwagger: wantsSwagger
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
        requireSwagger
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
    const packageFiles = files.filter((file) => path.basename(file).toLowerCase() === "package.json");
    const packageLockFiles = files.filter((file) => path.basename(file).toLowerCase() === "package-lock.json");

    const goModules = files.filter((file) => path.basename(file).toLowerCase() === "go.mod");
    const goFiles = files.filter((file) => file.toLowerCase().endsWith(".go"));
    const goText = goFiles.map((file) => readText(file)).join("\n");

    const reactRoots: string[] = [];
    let hasReactBuildSetup = false;
    for (const packageFile of packageFiles) {
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
    for (const packageFile of packageFiles) {
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
        const hasCompleteAngularRoot = angularRoots.some((root) => {
            const hasConfig = fs.existsSync(path.join(root, "angular.json"));
            const sourceRoot = path.join(root, "src");
            const hasSource = angularSources.some((file) => {
                const rel = path.relative(sourceRoot, file);
                return !rel.startsWith("..") && !path.isAbsolute(rel);
            });
            return hasConfig && hasSource;
        });
        if (angularRoots.length > 0 && !hasCompleteAngularRoot) missing.push("co-locate the frontend manifest, workspace configuration, and source under one project root");
        for (const configFile of files.filter((file) => path.basename(file).toLowerCase() === "angular.json")) {
            if (!fs.existsSync(path.join(path.dirname(configFile), "package.json"))) {
                missing.push(`remove or relocate orphan workspace configuration without a same-directory manifest: ${relative(configFile)}`);
            }
        }
    }
    if (requirement.requireReactApp || requirement.requireAngularApp) {
        for (const lockFile of packageLockFiles) {
            if (!fs.existsSync(path.join(path.dirname(lockFile), "package.json"))) {
                missing.push(`remove or relocate orphan lockfile without a same-directory manifest: ${relative(lockFile)}`);
            }
        }
        for (const packageFile of packageFiles) {
            const lockFile = path.join(path.dirname(packageFile), "package-lock.json");
            if (!fs.existsSync(lockFile)) continue;
            try {
                const manifest = JSON.parse(readText(packageFile)) as Record<string, unknown>;
                const lock = JSON.parse(readText(lockFile, 5_000_000)) as { packages?: Record<string, Record<string, unknown>> };
                const root = lock.packages?.[""];
                if (!root) continue;
                const keys = ["name", "version", "dependencies", "devDependencies"];
                const mismatchedKeys = keys.filter((key) => root[key] !== undefined
                    && JSON.stringify(manifest[key] ?? {}) !== JSON.stringify(root[key] ?? {}));
                if (mismatchedKeys.length > 0) {
                    const manifestDependencies = manifest.dependencies && typeof manifest.dependencies === "object"
                        ? Object.keys(manifest.dependencies as Record<string, unknown>) : [];
                    const lockDependencies = root.dependencies && typeof root.dependencies === "object"
                        ? Object.keys(root.dependencies as Record<string, unknown>) : [];
                    const onlyManifest = manifestDependencies.filter((name) => !lockDependencies.includes(name));
                    const onlyLock = lockDependencies.filter((name) => !manifestDependencies.includes(name));
                    const dependencyDiff = onlyManifest.length > 0 || onlyLock.length > 0
                        ? ` Dependency keys only in manifest: [${onlyManifest.join(", ") || "none"}]; only in lockfile: [${onlyLock.join(", ") || "none"}].`
                        : "";
                    missing.push(`align ${relative(packageFile)} with same-directory package-lock.json root metadata for fields [${mismatchedKeys.join(", ")}]; copy those lockfile values exactly instead of guessing.${dependencyDiff}`);
                }
            } catch {
                // Syntax errors are reported by normal validators and build commands.
            }
        }
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
    const placeholderFiles = [...reactSources, ...angularSources]
        .filter((file) => /<[^>]+>\s*[\w-]+\s+works!\s*<\//i.test(readText(file)))
        .map(relative);
    if (requirement.requireFrontendApiCall && placeholderFiles.length > 0) {
        missing.push(`replace generated placeholder frontend content with UI that renders the requested API data; placeholder found in [${placeholderFiles.join(", ")}]`);
    }
    if (requirement.requireAngularApp && requirement.requireFrontendApiCall && /\bHttpClient\b/.test(angularText)) {
        const standaloneBootstrap = angularSources
            .filter((file) => path.basename(file).toLowerCase() === "main.ts")
            .some((file) => /\bbootstrapApplication\s*\(/.test(readText(file)));
        const hasStandaloneHttpProvider = /\bprovideHttpClient\s*\(|\bimportProvidersFrom\s*\([^)]*\bHttpClientModule\b/s.test(angularText);
        if (standaloneBootstrap && !hasStandaloneHttpProvider) {
            const activeConfigCandidates = angularSources
                .filter((file) => /\bApplicationConfig\b|\bprovideRouter\s*\(|\bbootstrapApplication\s*\(/.test(readText(file)))
                .map(relative);
            missing.push(`register the HTTP client provider in the active standalone application bootstrap configuration; inspect active config candidates [${activeConfigCandidates.join(", ") || "none found"}] rather than an unused module`);
        }
        if (standaloneBootstrap) {
            const unusedRootModules = angularSources.filter((file) => path.basename(file).toLowerCase() === "app.module.ts");
            if (unusedRootModules.length > 0) {
                missing.push(`remove unused legacy root bootstrap modules because the application uses standalone bootstrap; stale files [${unusedRootModules.map(relative).join(", ")}] must not carry duplicate routing/providers`);
            }
        }
    }
    if (requirement.requireFrontendApiCall) {
        const localApiOrigins = Array.from(frontendText.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/gi));
        if (localApiOrigins.length > 0 && !/Access-Control-Allow-Origin|\bcors\b/i.test(goText)) {
            missing.push("configure cross-origin API access because the frontend calls an absolute local API origin; add an explicit CORS policy or use a same-origin proxy/relative URL");
        }

        const backendJsonFields = new Set(Array.from(goText.matchAll(/`json:["']([^,"']+)/g), (match) => match[1]));
        const renderedFields = new Set(Array.from(frontendText.matchAll(/\{\{\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g), (match) => match[1]));
        const unknownRenderedFields = Array.from(renderedFields).filter((field) => !backendJsonFields.has(field));
        if (backendJsonFields.size > 0 && unknownRenderedFields.length > 0) {
            missing.push(`align rendered frontend fields with the backend JSON contract; fields absent from backend JSON: [${unknownRenderedFields.join(", ")}]`);
        }
    }
    const angularRouteConfigFiles = angularSources.filter((file) => (
        /(?:^|[.])routes?\.ts$/i.test(path.basename(file))
        || /\bexport\s+const\s+\w*routes\w*\s*:\s*Routes\b/i.test(readText(file))
    ));
    const angularRouteConfigText = angularRouteConfigFiles.map((file) => readText(file)).join("\n");
    if (requirement.requireAngularApp
        && /<router-outlet\b/i.test(angularText)
        && /\bpath\s*:\s*["'][^"']+["']/i.test(angularRouteConfigText)
        && !/\bpath\s*:\s*["']\s*["']/i.test(angularRouteConfigText)) {
        missing.push(`add a default frontend route or redirect in the active route configuration so the requested UI renders at the application's initial URL; inspect [${angularRouteConfigFiles.map(relative).join(", ") || "no route config found"}] rather than an unused module`);
    }
    if (requirement.requireSwagger) {
        const namedArtifact = files.some((file) => /(?:^|\/)(?:swagger|openapi)(?:[./_-]|$)/i.test(relative(file)));
        const sourceIntegration = /swagger|openapi/i.test(goText + "\n" + frontendText);
        if (!namedArtifact && !sourceIntegration) missing.push("Swagger/OpenAPI specification or route integration");
    }

    return missing;
}

function relativePath(workspace: string, target: string): string {
    return path.relative(workspace, target).replace(/\\/g, "/") || ".";
}

function createProjectCheck(
    workspace: string,
    manifestPath: string,
    label: string,
    command: string,
    ecosystem: string,
    affectedExtensions: string[],
    affectedFiles: string[]
): ProjectCheck {
    const relativeManifest = relativePath(workspace, manifestPath);
    return {
        id: `${relativeManifest.toLowerCase()}::${command.toLowerCase()}`,
        label,
        command,
        workdir: relativePath(workspace, path.dirname(manifestPath)),
        manifestPath: relativeManifest,
        ecosystem,
        affectedExtensions,
        affectedFiles
    };
}

function discoverProjectChecks(workspace: string): ProjectCheck[] {
    const files = collectFiles(workspace);
    const checks: ProjectCheck[] = [];

    for (const manifestPath of files.filter((file) => path.basename(file).toLowerCase() === "package.json")) {
        try {
            const parsed = JSON.parse(readText(manifestPath)) as {
                name?: unknown;
                scripts?: Record<string, unknown>;
                dependencies?: Record<string, unknown>;
                devDependencies?: Record<string, unknown>;
            };
            const scripts = parsed.scripts ?? {};
            const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
            const ecosystem = dependencies["@angular/core"] ? "angular" : dependencies.react ? "react" : "node";
            const priority = ecosystem === "node"
                ? ["test", "build", "check", "typecheck", "lint"]
                : ["build", "test", "check", "typecheck", "lint"];
            const script = priority.find((name) => typeof scripts[name] === "string" && String(scripts[name]).trim().length > 0);
            if (!script) continue;
            const root = path.dirname(manifestPath);
            const runner = fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))
                ? "bun" : fs.existsSync(path.join(root, "pnpm-lock.yaml"))
                    ? "pnpm" : fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
            const command = script === "test" ? `${runner} test` : `${runner} run ${script}`;
            const projectName = typeof parsed.name === "string" && parsed.name.trim()
                ? parsed.name.trim() : relativePath(workspace, root);
            checks.push(createProjectCheck(
                workspace,
                manifestPath,
                `${projectName} ${script}`,
                command,
                ecosystem,
                [".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html"],
                ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "angular.json", "tsconfig.json"]
            ));
        } catch {
            // Invalid manifests are handled by normal validation.
        }
    }

    for (const manifestPath of files.filter((file) => path.basename(file).toLowerCase() === "go.mod")) {
        checks.push(createProjectCheck(workspace, manifestPath, `${relativePath(workspace, path.dirname(manifestPath))} Go tests`, "go test ./...", "go", [".go"], ["go.mod", "go.sum"]));
    }
    for (const manifestPath of files.filter((file) => path.basename(file).toLowerCase() === "cargo.toml")) {
        checks.push(createProjectCheck(workspace, manifestPath, `${relativePath(workspace, path.dirname(manifestPath))} Rust tests`, "cargo test", "rust", [".rs"], ["cargo.toml", "cargo.lock"]));
    }
    for (const manifestPath of files.filter((file) => path.basename(file).toLowerCase() === "pyproject.toml")) {
        const content = readText(manifestPath);
        if (/\bpytest\b|\[tool\.pytest\./i.test(content)) {
            checks.push(createProjectCheck(workspace, manifestPath, `${relativePath(workspace, path.dirname(manifestPath))} Python tests`, "python -m pytest", "python", [".py"], ["pyproject.toml", "pytest.ini"]));
        }
    }
    for (const manifestPath of files.filter((file) => /\.(?:sln|csproj)$/i.test(file))) {
        const root = path.dirname(manifestPath);
        const hasSolutionInRoot = files.some((file) => path.dirname(file) === root && /\.sln$/i.test(file));
        if (/\.csproj$/i.test(manifestPath) && hasSolutionInRoot) continue;
        const manifestName = path.basename(manifestPath);
        checks.push(createProjectCheck(workspace, manifestPath, `${relativePath(workspace, root)} .NET build`, `dotnet build "${manifestName}"`, "dotnet", [".cs", ".fs", ".vb", ".cshtml"], [manifestName, "Directory.Build.props", "Directory.Build.targets"]));
    }
    for (const manifestPath of files.filter((file) => path.basename(file).toLowerCase() === "pom.xml")) {
        checks.push(createProjectCheck(workspace, manifestPath, `${relativePath(workspace, path.dirname(manifestPath))} Maven tests`, "mvn test", "java", [".java", ".kt"], ["pom.xml"]));
    }

    return checks;
}

function normalizeCommand(command: string): string {
    return command.toLowerCase().replace(/\.cmd\b/g, "").replace(/\s+/g, " ").trim();
}

function projectChecksForCommand(command: string, checks: ProjectCheck[], workdir?: string): string[] {
    const normalizedCommand = normalizeCommand(command);
    const normalizedWorkdir = workdir?.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return checks.filter((check) => {
        const commandMatches = normalizedCommand.includes(normalizeCommand(check.command));
        if (!commandMatches || !normalizedWorkdir) return commandMatches;
        const checkWorkdir = check.workdir.replace(/\\/g, "/").toLowerCase();
        return normalizedWorkdir === checkWorkdir || normalizedWorkdir.endsWith(`/${checkWorkdir}`);
    }).map((check) => check.id);
}

function projectChecksAffectedByPath(filePath: string, checks: ProjectCheck[]): string[] {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const candidates = checks.filter((check) => {
        const root = check.workdir === "." ? "" : `${check.workdir.toLowerCase().replace(/\\/g, "/")}/`;
        if (root && !normalized.startsWith(root)) return false;
        const basename = path.posix.basename(normalized);
        const extension = path.posix.extname(normalized);
        return check.affectedFiles.some((file) => file.toLowerCase() === basename)
            || check.affectedExtensions.includes(extension);
    });
    if (candidates.length === 0) return [];
    const deepestRoot = Math.max(...candidates.map((check) => check.workdir === "." ? 0 : check.workdir.length));
    return candidates.filter((check) => (check.workdir === "." ? 0 : check.workdir.length) === deepestRoot).map((check) => check.id);
}

function projectChecksAffectedByWorkdir(workdir: string | undefined, checks: ProjectCheck[]): string[] {
    if (!workdir) return checks.map((check) => check.id);
    const normalized = workdir.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return checks.filter((check) => {
        const root = check.workdir.replace(/\\/g, "/").toLowerCase();
        return root === "." || normalized === root || normalized.startsWith(`${root}/`) || root.startsWith(`${normalized}/`);
    }).map((check) => check.id);
}

function requiredProjectChecks(requirement: ProjectCompletionRequirement, checks: ProjectCheck[]): ProjectCheck[] {
    return checks.filter((check) => (
        (requirement.requireGoModule && check.ecosystem === "go")
        || (requirement.requireReactApp && check.ecosystem === "react")
        || (requirement.requireAngularApp && check.ecosystem === "angular")
    ));
}

function formatProjectChecksPrompt(checks: ProjectCheck[]): string {
    if (checks.length === 0) {
        return "No finite project verification command was discovered yet. Inspect manifests created during the task; the runtime will discover their declared checks after each mutation.";
    }
    const lines = checks.map((check) => `- ${check.label}: run \`${check.command}\` with workdir \`${check.workdir}\` (from ${check.manifestPath})`);
    return `Workspace verification checks discovered from manifests:\n${lines.join("\n")}\nThese commands are runtime facts, not suggestions invented from the request. After changing an affected file, rerun its check successfully before final.`;
}

function protectedProjectDeletionReason(workspace: string, filePath: string, request: string): string | undefined {
    const absolute = path.resolve(workspace, filePath);
    const basename = path.basename(absolute).toLowerCase();
    if (!/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(basename)) return undefined;
    if (!fs.existsSync(path.join(path.dirname(absolute), "package.json"))) return undefined;
    const explicitRemoval = /(?:remove|delete|ลบ|เอาออก)[\s\S]{0,50}(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|lockfile|lock file)/i.test(request);
    return explicitRemoval
        ? undefined
        : `preserve active project lockfile ${filePath}; it is co-located with package.json and the request did not explicitly ask to remove it`;
}

function formatProjectCompletionPrompt(requirement: ProjectCompletionRequirement, checks: ProjectCheck[] = []): string {
    const items: string[] = [];
    if (requirement.requireGoModule) items.push("a go.mod and Go application source");
    if (requirement.requireGoJsonApi) items.push("an HTTP route returning structured JSON");
    if (requirement.requireReactApp) items.push("a React package.json and source under src/");
    if (requirement.requireAngularApp) items.push("an Angular package.json, angular.json, and source under src/");
    if (requirement.forbidReactArtifacts) items.push("remove old React source, scripts, and dependencies");
    if (requirement.forbidAngularArtifacts) items.push("remove old Angular source, scripts, and dependencies");
    if (requirement.requireFrontendApiCall) items.push("a real frontend API call using fetch, axios, or Angular HttpClient");
    if (requirement.requireSwagger) items.push("Swagger/OpenAPI specification or route integration");
    const requiredChecks = requiredProjectChecks(requirement, checks);
    for (const check of requiredChecks) items.push(`successful verification '${check.command}' in '${check.workdir}'`);
    if ((requirement.requireGoModule || requirement.requireReactApp || requirement.requireAngularApp) && requiredChecks.length === 0) {
        items.push("a finite verification command discovered from each completed project manifest");
    }
    return `Project completion profile (${requirement.label}): before final, ensure ${items.join("; ")}. A frontend manifest, its workspace configuration, source directory, and build command must belong to the same project root; do not scatter them across unrelated directories. Use a finite build/test command rather than a long-running development server for verification. Do not return a starter scaffold or defer required work to the user.`;
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
    discoverProjectChecks,
    evaluateProjectCompletion,
    formatIncompleteTaskAnswer,
    formatProjectCompletionPrompt,
    formatProjectChecksPrompt,
    inferProjectCompletionRequirement,
    inferProjectCompletionRequirementWithHistory,
    protectedProjectDeletionReason,
    projectChecksAffectedByPath,
    projectChecksAffectedByWorkdir,
    projectChecksForCommand,
    requiredProjectChecks
};
