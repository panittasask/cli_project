import assert = require("node:assert/strict");
import childProcess = require("node:child_process");
import fs = require("node:fs");
import http = require("node:http");
import os = require("node:os");
import path = require("node:path");
const { runAgentCliHarness } = require("./agent-cli-harness") as {
    runAgentCliHarness: (options: Record<string, unknown>) => Promise<{ output: string; stderr: string; exitCode: number }>;
};

function request(port: number, requestPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const client = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 5_000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        client.on("timeout", () => client.destroy(new Error("HTTP request timed out")));
        client.on("error", reject);
    });
}

function runNpmTest(root: string): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync("npm.cmd", ["test"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true
    });
}

function reportNpmTestFailure(root: string, testRun: childProcess.SpawnSyncReturns<string>): void {
    console.error(`Generated npm test failed or timed out (status=${testRun.status}, signal=${testRun.signal}).`);
    console.error(String(testRun.stdout ?? "").slice(-2_000));
    console.error(String(testRun.stderr ?? "").slice(-2_000));
    console.error("Generated server.js:\n" + fs.readFileSync(path.join(root, "server.js"), "utf8").slice(0, 4_000));
    console.error("Generated test.js:\n" + fs.readFileSync(path.join(root, "test.js"), "utf8").slice(0, 4_000));
}

async function waitForServer(port: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            const response = await request(port, "/api/hello");
            if (response.status === 200) return;
        } catch {
            // The child may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Generated full-stack server did not become ready within 15 seconds.");
}

async function main(): Promise<void> {
    const apiUrl = process.env.LLAMA_API_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-live-full-stack-"));
    const port = 48_000 + Math.floor(Math.random() * 1_000);
    let server: childProcess.ChildProcess | undefined;
    try {
        const result = await runAgentCliHarness({
            appRoot: root,
            workspace: root,
            apiUrl,
            clarificationAnswers: ["new_project"],
            prompt: [
                "Create a complete minimal full-stack project in this empty workspace.",
                "Use exactly package.json, server.js, test.js, and public/index.html.",
                "Use only Node.js built-ins; do not install dependencies.",
                "The backend in server.js must read and serve the actual public/index.html file for GET / and serve GET /api/hello with JSON containing a message.",
                "The frontend must call fetch('/api/hello') and render the returned message in the page.",
                "Make server.js export a createServer function, respect process.env.PORT when run directly, and make package.json provide finite npm test and npm start scripts.",
                "Make test.js use only built-in node:http.request (do not use fetch or node-fetch), require createServer, listen on port 0, verify /api/hello, and explicitly await the server.close callback in a finally block; npm test must terminate on its own within 10 seconds and must not start a watch process or leave server.js listening."
            ].join(" "),
            timeoutMs: 300_000,
            environment: {
                CLI_AGENT_PROFILE: "standard",
                CLI_AGENT_MAX_TURNS: "12",
                CLI_AGENT_MAX_SEGMENTS: "1",
                CLI_AGENT_MAX_MINUTES: "4",
                LLAMA_ACTION_MAX_TOKENS: process.env.LLAMA_ACTION_MAX_TOKENS || "512"
            }
        });
        assert.equal(result.exitCode, 0, result.stderr);

        const packageJsonPath = path.join(root, "package.json");
        const serverPath = path.join(root, "server.js");
        const testPath = path.join(root, "test.js");
        const indexPath = path.join(root, "public", "index.html");
        const artifacts = [packageJsonPath, serverPath, testPath, indexPath];
        const missingArtifacts = artifacts.filter((artifact) => !fs.existsSync(artifact));
        if (missingArtifacts.length > 0) {
            console.error(`Missing generated artifacts: ${missingArtifacts.map((artifact) => path.relative(root, artifact)).join(", ")}`);
            console.error(`Workspace files: ${fs.readdirSync(root, { recursive: true }).join(", ")}`);
            console.error(`Agent output tail:\n${result.output.slice(-4_000)}`);
        }
        for (const artifact of artifacts) assert.equal(fs.existsSync(artifact), true, `Missing generated artifact: ${path.relative(root, artifact)}`);
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
        assert.match(packageJson.scripts?.test ?? "", /node\s+test\.js/i);
        assert.match(packageJson.scripts?.start ?? "", /node\s+server\.js/i);
        const serverSource = fs.readFileSync(serverPath, "utf8");
        const indexSource = fs.readFileSync(indexPath, "utf8");
        assert.match(serverSource, /api\/hello/);
        assert.match(indexSource, /fetch\s*\(\s*["'`]\/api\/hello["'`]/i);

        let testRun = runNpmTest(root);
        if (testRun.status !== 0) {
            reportNpmTestFailure(root, testRun);
            const repair = await runAgentCliHarness({
                appRoot: root,
                workspace: root,
                apiUrl,
                clarificationAnswers: ["new_project"],
                prompt: "Continue the current full-stack project and repair the failing npm test. Inspect server.js and test.js first. The test must use only node:http.request, await the response end, and await a Promise around server.close(resolve) so npm test exits cleanly. Do not use fetch, node-fetch, watch mode, or a long-running server. Preserve the / and /api/hello behavior, ensure running node server.js listens on process.env.PORT, and run npm test successfully before returning final.",
                timeoutMs: 180_000,
                environment: {
                    CLI_AGENT_PROFILE: "standard",
                    CLI_AGENT_MAX_TURNS: "8",
                    CLI_AGENT_MAX_SEGMENTS: "1",
                    CLI_AGENT_MAX_MINUTES: "3",
                    LLAMA_ACTION_MAX_TOKENS: process.env.LLAMA_ACTION_MAX_TOKENS || "512"
                }
            });
            assert.equal(repair.exitCode, 0, repair.stderr);
            testRun = runNpmTest(root);
        }
        if (testRun.status !== 0) reportNpmTestFailure(root, testRun);
        assert.equal(testRun.status, 0, `${testRun.stdout ?? ""}\n${testRun.stderr ?? ""}`);

        server = childProcess.spawn(process.execPath, [serverPath], {
            cwd: root,
            env: { ...process.env, PORT: String(port) },
            stdio: "ignore",
            windowsHide: true
        });
        await waitForServer(port);
        const page = await request(port, "/");
        const api = await request(port, "/api/hello");
        assert.equal(page.status, 200);
        assert.match(page.body, /fetch\s*\(/i);
        assert.equal(api.status, 200);
        assert.equal(JSON.parse(api.body).message !== undefined, true);
        console.log("Live full-stack project creation and runtime test passed.");
    } finally {
        if (server && server.exitCode === null) server.kill();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
