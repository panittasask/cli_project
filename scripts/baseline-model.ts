import axios = require("axios");
import fs = require("node:fs");
import path = require("node:path");
const { loadCliSettings, getSamplingSettings } = require("../cli/config") as {
    loadCliSettings: (appRoot?: string) => Record<string, unknown>;
    getSamplingSettings: (settings: Record<string, unknown>, kind: "chat") => Record<string, number>;
};

const appRoot = path.resolve(__dirname, "..");
const settings = loadCliSettings(appRoot);
const apiUrl = process.env.LLAMA_API_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
const sampling = getSamplingSettings(settings, "chat");
const questions = [
    "นกฮูกคืออะไร",
    "Meme 67 คืออะไร",
    "session ของ CLI เก็บที่ไหน"
];

function endpoint(route: string): string {
    return new URL(route, apiUrl).toString();
}

function inferQuantization(modelName: string): string | undefined {
    return modelName.match(/(?:^|[-_.])(iq\d[^-_.]*|q\d[^-_.]*)(?:[-_.]|$)/i)?.[1];
}

async function main(): Promise<void> {
    const modelsResponse = await axios.get(endpoint("/v1/models"), { timeout: 5000 });
    const loadedModels = Array.isArray(modelsResponse.data?.data) ? modelsResponse.data.data : [];
    const model = loadedModels.find((item: { id?: unknown }) => typeof item?.id === "string")?.id;
    if (!model) {
        throw new Error("llama-server did not report a loaded model at /v1/models");
    }

    let props: unknown;
    try {
        props = (await axios.get(endpoint("/props"), { timeout: 5000 })).data;
    } catch (error) {
        props = {
            unavailable: true,
            reason: axios.isAxiosError(error) ? error.message : String(error)
        };
    }

    const results: Array<{ question: string; answer: string; usage?: unknown }> = [];
    for (const question of questions) {
        console.log(`Testing: ${question}`);
        const response = await axios.post(apiUrl, {
            model,
            messages: [{ role: "user", content: question }],
            ...sampling
        }, { timeout: 120000 });

        results.push({
            question,
            answer: response.data?.choices?.[0]?.message?.content?.trim() ?? "",
            usage: response.data?.usage
        });
    }

    const report = {
        generatedAt: new Date().toISOString(),
        apiUrl,
        model,
        quantizationFromFilename: inferQuantization(model),
        directApi: true,
        historyIncluded: false,
        toolsIncluded: false,
        sampling,
        serverProperties: props,
        results
    };

    const outputDirectory = path.resolve(appRoot, ".cli", "logs", "baseline");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(outputDirectory, `baseline-model-${stamp}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

    console.log();
    console.log(`Model: ${model}`);
    console.log(`Sampling: ${JSON.stringify(sampling)}`);
    for (const result of results) {
        console.log();
        console.log(`Q: ${result.question}`);
        console.log(`A: ${result.answer}`);
    }
    console.log();
    console.log(`Baseline report: ${outputPath}`);
}

main().catch((error) => {
    const message = axios.isAxiosError(error)
        ? `${error.message}${error.response?.data ? `\n${JSON.stringify(error.response.data)}` : ""}`
        : error instanceof Error ? error.message : String(error);
    console.error(`Baseline failed: ${message}`);
    console.error("Start llama-server first with npm run dev or npm run llama.");
    process.exit(1);
});
