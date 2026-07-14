import fs = require("node:fs");
import path = require("node:path");
import readline = require("node:readline");

type SessionRole = "user" | "assistant";

interface SessionMessage {
    role: SessionRole;
    content: string;
    timestamp: number;
}

interface ChatSession {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: SessionMessage[];
}

interface SessionStore {
    version: number;
    sessions: ChatSession[];
}

class SessionTool {
    private readonly maxSessions = 12;
    private readonly maxMessagesPerSession = 24;
    private readonly maxMessageChars = 800;
    private readonly maxStorageBytes = 180 * 1024;

    private readonly storagePath: string;

    constructor(storagePath?: string) {
        this.storagePath = storagePath ?? path.resolve(process.cwd(), ".cli-sessions.json");
    }

    async selectSession(rl: readline.Interface): Promise<ChatSession> {
        while (true) {
            const store = this.loadStore();
            this.printMenu(store.sessions);
            const rawChoice = (await this.prompt(rl, "Select number, N new, D delete, or C clear all: ")).trim();

            if (/^n$/i.test(rawChoice)) {
                const rawTitle = (await this.prompt(rl, "Session name (optional): ")).trim();
                const title = rawTitle.length > 0 ? rawTitle : this.defaultSessionTitle();
                const created = this.createSession(title);
                console.log(`Using new session: ${created.title}`);
                console.log();
                return created;
            }

            if (/^d$/i.test(rawChoice)) {
                if (store.sessions.length === 0) {
                    console.log("No sessions to delete.");
                    console.log();
                    continue;
                }

                const rawIndex = (await this.prompt(rl, "Session number to delete: ")).trim();
                const deleteIndex = Number(rawIndex);
                const target = Number.isInteger(deleteIndex) ? store.sessions[deleteIndex - 1] : undefined;
                if (!target) {
                    console.log("Invalid session number.");
                    console.log();
                    continue;
                }

                const confirmation = (await this.prompt(rl, `Delete session "${target.title}"? (y/N): `)).trim();
                if (!/^y(es)?$/i.test(confirmation)) {
                    console.log("Delete cancelled.");
                    console.log();
                    continue;
                }

                this.deleteSession(target.id);
                console.log(`Deleted session: ${target.title}`);
                console.log();
                continue;
            }

            if (/^c$/i.test(rawChoice)) {
                if (store.sessions.length === 0) {
                    console.log("No sessions to clear.");
                    console.log();
                    continue;
                }

                const confirmation = (await this.prompt(
                    rl,
                    `Type DELETE to permanently remove all ${store.sessions.length} sessions: `
                )).trim();
                if (confirmation !== "DELETE") {
                    console.log("Clear cancelled.");
                    console.log();
                    continue;
                }

                const deletedCount = this.clearSessions();
                console.log(`Deleted ${deletedCount} sessions.`);
                console.log();
                continue;
            }

            const index = Number(rawChoice);

            if (!Number.isInteger(index) || index < 1 || index > store.sessions.length) {
                console.log("Invalid selection. Please try again.");
                continue;
            }

            const selected = store.sessions[index - 1];
            if (!selected) {
                console.log("Session not found. Please try again.");
                continue;
            }

            this.touchSession(selected.id);
            console.log(`Using session: ${selected.title}`);
            console.log();
            return this.getSession(selected.id) as ChatSession;
        }
    }

    getContextMessages(sessionId: string, maxMessages = 10, afterTimestamp = 0): SessionMessage[] {
        const session = this.getSession(sessionId);
        if (!session) {
            return [];
        }

        if (maxMessages <= 0) {
            return [];
        }

        return session.messages
            .filter((message) => message.timestamp > afterTimestamp)
            .slice(-maxMessages);
    }

    deleteSession(sessionId: string): boolean {
        const store = this.loadStore();
        const nextSessions = store.sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length === store.sessions.length) {
            return false;
        }

        store.sessions = nextSessions;
        this.saveStore(store);
        return true;
    }

    clearSessions(): number {
        const store = this.loadStore();
        const deletedCount = store.sessions.length;
        store.sessions = [];
        this.saveStore(store);
        return deletedCount;
    }

    appendExchange(sessionId: string, userMessage: string, assistantMessage: string): void {
        const store = this.loadStore();
        const session = store.sessions.find((item) => item.id === sessionId);

        if (!session) {
            return;
        }

        const now = Date.now();

        session.messages.push(
            {
                role: "user",
                content: this.trimMessage(userMessage),
                timestamp: now
            },
            {
                role: "assistant",
                content: this.trimMessage(assistantMessage),
                timestamp: now
            }
        );

        session.updatedAt = now;
        this.enforceLimits(store);
        this.saveStore(store);
    }

    private createSession(title: string): ChatSession {
        const store = this.loadStore();
        const now = Date.now();
        const session: ChatSession = {
            id: this.newSessionId(now),
            title: title.trim().slice(0, 60) || this.defaultSessionTitle(),
            createdAt: now,
            updatedAt: now,
            messages: []
        };

        store.sessions.unshift(session);
        this.enforceLimits(store);
        this.saveStore(store);

        return session;
    }

    private getSession(sessionId: string): ChatSession | undefined {
        return this.loadStore().sessions.find((session) => session.id === sessionId);
    }

    private touchSession(sessionId: string): void {
        const store = this.loadStore();
        const session = store.sessions.find((item) => item.id === sessionId);

        if (!session) {
            return;
        }

        session.updatedAt = Date.now();
        this.enforceLimits(store);
        this.saveStore(store);
    }

    private prompt(rl: readline.Interface, question: string): Promise<string> {
        return new Promise((resolve) => {
            rl.question(question, (answer) => resolve(answer));
        });
    }

    private printMenu(sessions: ChatSession[]): void {
        console.log("Available sessions:");

        if (sessions.length === 0) {
            console.log("No sessions yet.");
        } else {
            sessions.forEach((session, index) => {
                const when = new Date(session.updatedAt).toLocaleString();
                console.log(`${index + 1}. ${session.title} (${session.messages.length} msgs, updated ${when})`);
            });
        }

        console.log("N. New session");
        console.log("D. Delete one session");
        console.log("C. Clear all sessions");
    }

    private defaultSessionTitle(): string {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const hh = String(now.getHours()).padStart(2, "0");
        const min = String(now.getMinutes()).padStart(2, "0");
        return `Session ${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }

    private trimMessage(message: string): string {
        const clean = message.trim();
        if (clean.length <= this.maxMessageChars) {
            return clean;
        }

        return `${clean.slice(0, this.maxMessageChars)}...`;
    }

    private newSessionId(now: number): string {
        return `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    private enforceLimits(store: SessionStore): void {
        for (const session of store.sessions) {
            if (session.messages.length > this.maxMessagesPerSession) {
                session.messages = session.messages.slice(-this.maxMessagesPerSession);
            }
        }

        store.sessions.sort((a, b) => b.updatedAt - a.updatedAt);

        if (store.sessions.length > this.maxSessions) {
            store.sessions = store.sessions.slice(0, this.maxSessions);
        }

        while (this.estimateSize(store) > this.maxStorageBytes && store.sessions.length > 1) {
            const oldest = store.sessions[store.sessions.length - 1];

            if (!oldest) {
                break;
            }

            if (oldest.messages.length > 6) {
                oldest.messages = oldest.messages.slice(Math.floor(oldest.messages.length / 2));
                oldest.updatedAt = Date.now();
            } else {
                store.sessions.pop();
            }
        }
    }

    private estimateSize(store: SessionStore): number {
        return Buffer.byteLength(JSON.stringify(store), "utf8");
    }

    private loadStore(): SessionStore {
        if (!fs.existsSync(this.storagePath)) {
            return {
                version: 1,
                sessions: []
            };
        }

        try {
            const raw = fs.readFileSync(this.storagePath, "utf8");
            const parsed = JSON.parse(raw) as SessionStore;

            if (!parsed || !Array.isArray(parsed.sessions)) {
                throw new Error("Invalid session store format");
            }

            return {
                version: 1,
                sessions: parsed.sessions
            };
        } catch {
            return {
                version: 1,
                sessions: []
            };
        }
    }

    private saveStore(store: SessionStore): void {
        const content = JSON.stringify(store, null, 2);
        fs.writeFileSync(this.storagePath, content, "utf8");
    }
}

module.exports = {
    SessionTool
};
