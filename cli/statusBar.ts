type StatusBarState = {
    model: string;
    contextUsed: number;
    contextLimit: number;
    workspace: string;
};

function formatStatusBar(state: StatusBarState, columns: number): string {
    const context = `${state.contextUsed.toLocaleString()} / ${state.contextLimit.toLocaleString()}`;
    const modelName = state.model.replace(/^.*[\\/]/, "");
    const fixedTextLength = ` MODEL   |  CONTEXT ${context}  |  WORKSPACE  `.length;
    const availableValueWidth = Math.max(0, columns - fixedTextLength);
    const modelWidth = Math.max(1, Math.floor(availableValueWidth * 0.45));
    const workspaceWidth = Math.max(1, availableValueWidth - modelWidth);
    const shorten = (value: string, width: number, preserveEnd = false): string => {
        if (value.length <= width) {
            return value;
        }
        if (width <= 1) {
            return "…";
        }
        if (!preserveEnd || width < 5) {
            return `${value.slice(0, width - 1)}…`;
        }

        const startLength = Math.max(1, Math.floor((width - 1) * 0.4));
        return `${value.slice(0, startLength)}…${value.slice(-(width - startLength - 1))}`;
    };
    const fullText = ` MODEL ${shorten(modelName, modelWidth)}  |  CONTEXT ${context}  |  WORKSPACE ${shorten(state.workspace, workspaceWidth, true)} `;

    if (columns <= 1) {
        return "";
    }

    if (fullText.length > columns) {
        return `${fullText.slice(0, Math.max(0, columns - 1))}…`;
    }

    return fullText.padEnd(columns, " ");
}

class StatusBar {
    private active = false;
    private suspended = true;

    constructor(private readonly getState: () => StatusBarState) {}

    start(): void {
        if (this.active || !process.stdout.isTTY) {
            return;
        }

        this.active = true;
        this.suspended = true;
    }

    suspend(): void {
        if (!this.active || this.suspended) {
            return;
        }

        this.suspended = true;
    }

    resume(): void {
        if (!this.active || !this.suspended) {
            this.render();
            return;
        }

        this.suspended = false;
        this.render();
    }

    render(): void {
        const rows = process.stdout.rows ?? 0;
        const columns = process.stdout.columns ?? 0;
        if (!this.active || this.suspended || rows < 3 || columns < 2) {
            return;
        }

        const content = formatStatusBar(this.getState(), columns);
        process.stdout.write(`\x1b[7m${content}\x1b[0m\n`);
    }

    stop(): void {
        if (!this.active) {
            return;
        }

        this.active = false;
        this.suspended = true;
    }
}

module.exports = {
    StatusBar,
    formatStatusBar
};
