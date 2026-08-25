import assert = require("node:assert/strict");

const { resolveLaunchMode, selectBackend, selectReleaseAssets } = require("./launcher") as {
    resolveLaunchMode: (settings: Record<string, unknown>, environment?: NodeJS.ProcessEnv) => { kind: string; apiUrl: string };
    selectBackend: (hardware: string, platform?: NodeJS.Platform, architecture?: string) => string;
    selectReleaseAssets: (release: Record<string, unknown>, backend: string, platform?: NodeJS.Platform, architecture?: string) => Array<{ name: string }>;
};

const external = resolveLaunchMode({}, { LLAMA_API_URL: "http://model-host:9000/v1/chat/completions" });
assert.deepEqual(external, { kind: "external", apiUrl: "http://model-host:9000/v1/chat/completions" });

const local = resolveLaunchMode({ serverPort: 8181 }, {});
assert.deepEqual(local, { kind: "local", apiUrl: "http://127.0.0.1:8181/v1/chat/completions" });

const configuredRemote = resolveLaunchMode({ apiUrl: "http://model-server:8080/v1/chat/completions" }, {});
assert.deepEqual(configuredRemote, { kind: "external", apiUrl: "http://model-server:8080/v1/chat/completions" });

const prototypeLoopback = resolveLaunchMode({ apiUrl: "http://127.0.0.1:8080/v1/chat/completions" }, {});
assert.equal(prototypeLoopback.kind, "local");

const openRouter = resolveLaunchMode({ provider: "openrouter" }, {});
assert.deepEqual(openRouter, { kind: "external", apiUrl: "https://openrouter.ai/api/v1/chat/completions" });

const openRouterEnvironment = resolveLaunchMode({}, { LLM_PROVIDER: "openrouter" });
assert.deepEqual(openRouterEnvironment, { kind: "external", apiUrl: "https://openrouter.ai/api/v1/chat/completions" });

assert.equal(selectBackend("NVIDIA GeForce RTX 4070 SUPER", "win32", "x64"), "cuda");
assert.equal(selectBackend("Intel(R) Arc(TM) A770 Graphics", "win32", "x64"), "sycl");
assert.equal(selectBackend("AMD Radeon RX 7900 XTX", "win32", "x64"), "vulkan");
assert.equal(selectBackend("Apple M4", "darwin", "arm64"), "metal");
assert.equal(selectBackend("Microsoft Basic Display Adapter", "win32", "x64"), "cpu");

const release = {
    tag_name: "b12345",
    assets: [
        { name: "llama-b12345-bin-win-cuda-12.4-x64.zip" },
        { name: "cudart-llama-bin-win-cuda-12.4-x64.zip" },
        { name: "llama-b12345-bin-win-sycl-x64.zip" },
        { name: "llama-b12345-bin-win-vulkan-x64.zip" },
        { name: "llama-b12345-bin-win-cpu-x64.zip" },
        { name: "llama-b12345-bin-ubuntu-x64.tar.gz" },
        { name: "llama-b12345-bin-macos-arm64.tar.gz" }
    ]
};

assert.deepEqual(
    selectReleaseAssets(release, "cuda", "win32", "x64").map((asset) => asset.name),
    ["llama-b12345-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]
);
assert.deepEqual(
    selectReleaseAssets(release, "sycl", "win32", "x64").map((asset) => asset.name),
    ["llama-b12345-bin-win-sycl-x64.zip"]
);
assert.deepEqual(
    selectReleaseAssets(release, "cpu", "linux", "x64").map((asset) => asset.name),
    ["llama-b12345-bin-ubuntu-x64.tar.gz"]
);

console.log("Cross-platform launcher tests passed.");
