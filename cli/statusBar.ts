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

function buildStatusBarFrame(state: StatusBarState, columns: number, rows: number): string {
    if (rows < 3 || columns < 2) return "";
    const content = formatStatusBar(state, columns);
    // Save/restore the application cursor so painting the fixed bottom row
    // never changes readline or spinner output position. No newline is emitted.
    return `\x1b7\x1b[${rows};1H\x1b[7m${content}\x1b[0m\x1b8`;
}

class StatusBar {
    private active = false;
    private suspended = true;
    private reservedRows = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    private readonly handleResize = (): void => {
        if (!this.active || this.suspended) return;
        this.reserveBottomRow(true);
        this.render();
    };

    constructor(private readonly getState: () => StatusBarState) {}

    start(): void {
        if (this.active || !process.stdout.isTTY) {
            return;
        }

        this.active = true;
        this.suspended = false;
        process.stdout.on("resize", this.handleResize);
        this.reserveBottomRow(false, true);
        this.render();
        this.refreshTimer = setInterval(() => this.render(), 250);
        this.refreshTimer.unref();
    }

    suspend(): void {
        if (!this.active || this.suspended) {
            return;
        }

        this.clearBottomRow();
        this.restoreScrollRegion();
        this.suspended = true;
    }

    resume(): void {
        if (!this.active || !this.suspended) {
            this.render();
            return;
        }

        this.suspended = false;
        this.reserveBottomRow();
        this.render();
    }

    render(): void {
        const rows = process.stdout.rows ?? 0;
        const columns = process.stdout.columns ?? 0;
        if (!this.active || this.suspended || rows < 3 || columns < 2) {
            return;
        }

        if (rows !== this.reservedRows) {
            this.reserveBottomRow(true);
        }

        process.stdout.write(buildStatusBarFrame(this.getState(), columns, rows));
    }

    stop(): void {
        if (!this.active) {
            return;
        }

        if (!this.suspended) {
            this.clearBottomRow();
            this.restoreScrollRegion();
        }
        process.stdout.off("resize", this.handleResize);
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
        this.active = false;
        this.suspended = true;
        this.reservedRows = 0;
    }

    private reserveBottomRow(reset = false, placeCursorAboveBanner = false): void {
        const rows = process.stdout.rows ?? 0;
        if (rows < 3) return;
        const resetSequence = reset ? "\x1b[r" : "";
        if (placeCursorAboveBanner) {
            process.stdout.write(`${resetSequence}\x1b[1;${rows - 1}r\x1b[${rows - 1};1H\x1b[2K`);
        } else {
            process.stdout.write(`\x1b7${resetSequence}\x1b[1;${rows - 1}r\x1b8`);
        }
        this.reservedRows = rows;
    }

    private restoreScrollRegion(): void {
        process.stdout.write("\x1b7\x1b[r\x1b8");
    }

    private clearBottomRow(): void {
        const rows = process.stdout.rows ?? 0;
        if (rows < 1) return;
        process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
    }
}

module.exports = {
    StatusBar,
    buildStatusBarFrame,
    formatStatusBar
};
