import fs = require("node:fs");
import path = require("node:path");

const { ModelRouterClient, resolveRouterModel } = require("../cli/modelRouter") as {
    ModelRouterClient: new (apiUrl: string, loadTimeoutMs?: number) => {
        list: () => Promise<RouterModel[]>;
        switch: (selection: string) => Promise<{ model: RouterModel; unloaded: string[] }>;
        formatError: (error: unknown) => string;
    };
    resolveRouterModel: (models: RouterModel[], selection: string) => RouterModel | undefined;
};

type RouterModel = {
    id: string;
    path?: string;
    status: string;
    failed: boolean;
};

type CliSettings = {
    apiUrl?: string;
    modelPath?: string;
    defaultModel?: string;
    [key: string]: unknown;
};

const appRoot = path.resolve(__dirname, "..");
const settingsPath = path.join(appRoot, ".cli", "settings.json");
const exampleSettingsPath = path.join(appRoot, ".cli", "settings.example.json");

function readJson(filePath: string): CliSettings {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as CliSettings;
}

function loadSettings(): { settings: CliSettings; sourcePath: string } {
    if (fs.existsSync(settingsPath)) return { settings: readJson(settingsPath), sourcePath: settingsPath };
    if (fs.existsSync(exampleSettingsPath)) return { settings: readJson(exampleSettingsPath), sourcePath: exampleSettingsPath };
    return { settings: {}, sourcePath: settingsPath };
}

function normalizedModelName(value: string): string {
    return path.basename(value).replace(/\.gguf$/i, "").toLowerCase();
}

function resolveModelFilename(model: RouterModel, modelDirectory: string): string {
    const targetName = normalizedModelName(model.path || model.id);
    if (fs.existsSync(modelDirectory)) {
        const filename = fs.readdirSync(modelDirectory, { withFileTypes: true })
            .find((entry) => entry.isFile()
                && entry.name.toLowerCase().endsWith(".gguf")
                && normalizedModelName(entry.name) === targetName)?.name;
        if (filename) return filename;
    }
    return model.id.toLowerCase().endsWith(".gguf") ? path.basename(model.id) : `${path.basename(model.id)}.gguf`;
}

function printModels(models: RouterModel[], defaultModel?: string): void {
    const configured = defaultModel ? normalizedModelName(defaultModel) : "";
    console.log("Available server models");
    for (const [index, model] of models.entries()) {
        const marker = normalizedModelName(model.id) === configured ? " (default)" : "";
        console.log(`[${index + 1}] ${model.id} [${model.status}]${marker}`);
    }
}

async function main(): Promise<void> {
    const { settings, sourcePath } = loadSettings();
    const apiUrl = process.env.LLAMA_API_URL?.trim()
        || settings.apiUrl?.trim()
        || "http://127.0.0.1:8080/v1/chat/completions";
    const modelDirectory = process.env.LLAMA_MODEL_DIR?.trim() || settings.modelPath?.trim() || "D:\\Model";
    const selection = process.argv.slice(2).join(" ").trim();
    const client = new ModelRouterClient(apiUrl);

    try {
        const models = await client.list();
        if (!selection) {
            printModels(models, settings.defaultModel);
            console.log("\nLoad one with: npm run server:model -- <number-or-name>");
            return;
        }

        const target = resolveRouterModel(models, selection);
        if (!target) {
            printModels(models, settings.defaultModel);
            throw new Error(`Model not found: ${selection}`);
        }

        console.log(`Loading server model: ${target.id}`);
        const result = await client.switch(selection);
        const defaultModel = resolveModelFilename(result.model, modelDirectory);
        const persistedSettings = sourcePath === settingsPath ? settings : { ...settings };
        persistedSettings.defaultModel = defaultModel;
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, `${JSON.stringify(persistedSettings, null, 2)}\n`, "utf8");

        for (const unloaded of result.unloaded) console.log(`Unloaded: ${unloaded}`);
        console.log(`Loaded: ${result.model.id}`);
        console.log(`Saved defaultModel: ${defaultModel}`);
    } catch (error) {
        throw new Error(client.formatError(error));
    }
}

main().catch((error) => {
    console.error(`server:model failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
