const ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    brightCyan: "\x1b[96m",
    green: "\x1b[32m",
    red: "\x1b[31m"
};

const DEFAULT_LLM_MESSAGE_COLOR = "blue";
const TERMINAL_FOREGROUND_COLORS: Record<string, number> = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
    default: 39,
    "bright-black": 90,
    "bright-red": 91,
    "bright-green": 92,
    "bright-yellow": 93,
    "bright-blue": 94,
    "bright-magenta": 95,
    "bright-cyan": 96,
    "bright-white": 97
};
const TERMINAL_FOREGROUND_CODES = new Set(Object.values(TERMINAL_FOREGROUND_COLORS));

function terminalColorsEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
    return Boolean(stream.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
}

function normalizeTerminalColor(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value).trim().toLowerCase().replace(/_/g, "-");
    if (normalized in TERMINAL_FOREGROUND_COLORS) return normalized;
    if (!/^\d{2}$/.test(normalized)) return undefined;
    return TERMINAL_FOREGROUND_CODES.has(Number(normalized)) ? normalized : undefined;
}

function isSupportedTerminalColor(value: unknown): boolean {
    return normalizeTerminalColor(value) !== undefined;
}

function terminalForeground(value: unknown): string {
    const normalized = normalizeTerminalColor(value) ?? DEFAULT_LLM_MESSAGE_COLOR;
    const code = TERMINAL_FOREGROUND_COLORS[normalized] ?? Number(normalized);
    return `\x1b[${code}m`;
}

function formatAiResponse(
    answer: string,
    colors = terminalColorsEnabled(),
    messageColor: string | number = DEFAULT_LLM_MESSAGE_COLOR
): string {
    const clean = answer.trim();
    if (!colors) return `\nAI:\n\n${clean}\n`;
    const foreground = terminalForeground(messageColor);
    return `\n${ANSI.bold}${foreground}AI:${ANSI.reset}\n\n${foreground}${clean}${ANSI.reset}\n`;
}

function colorDiffLine(line: string, colors = terminalColorsEnabled()): string {
    if (!colors) return line;
    if (line.startsWith("+ ")) return `${ANSI.green}${line}${ANSI.reset}`;
    if (line.startsWith("- ")) return `${ANSI.red}${line}${ANSI.reset}`;
    if (line.startsWith("Diff preview:")) return `${ANSI.bold}${line}${ANSI.reset}`;
    if (line.startsWith("… ")) return `${ANSI.dim}${line}${ANSI.reset}`;
    return line;
}

module.exports = {
    ANSI,
    DEFAULT_LLM_MESSAGE_COLOR,
    colorDiffLine,
    formatAiResponse,
    isSupportedTerminalColor,
    normalizeTerminalColor,
    terminalForeground,
    terminalColorsEnabled
};
