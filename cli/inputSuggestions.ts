type SuggestionKind = "slash" | "skill" | "model";

type SuggestionSource = {
    value: string;
    description: string;
};

type InputSuggestion = SuggestionSource & {
    kind: SuggestionKind;
    replaceStart: number;
    replaceEnd: number;
    appendSpace: boolean;
};

type BuildInputSuggestionsInput = {
    line: string;
    cursor: number;
    slashCommands: SuggestionSource[];
    skills: SuggestionSource[];
    models: SuggestionSource[];
    limit?: number;
};

type InputSuggestionAcceptance = {
    line: string;
    cursor: number;
    submit: boolean;
};

function rankMatches(items: SuggestionSource[], query: string): SuggestionSource[] {
    const normalized = query.toLowerCase();
    const prefix: SuggestionSource[] = [];
    const partial: SuggestionSource[] = [];
    for (const item of items) {
        const candidate = item.value.toLowerCase();
        if (candidate.startsWith(normalized)) prefix.push(item);
        else if (candidate.includes(normalized)) partial.push(item);
    }
    return [...prefix, ...partial];
}

function buildInputSuggestions(input: BuildInputSuggestionsInput): InputSuggestion[] {
    const cursor = Math.max(0, Math.min(input.cursor, input.line.length));
    const beforeCursor = input.line.slice(0, cursor);
    const limit = Math.max(1, input.limit ?? 5);

    const exactModelMatch = beforeCursor.match(/^(\s*)\/model$/i);
    if (exactModelMatch) {
        const leadingWhitespace = (exactModelMatch[1] ?? "").length;
        return input.models.slice(0, limit).map((item) => ({
            ...item,
            value: `/model ${item.value}`,
            kind: "model",
            replaceStart: leadingWhitespace,
            replaceEnd: cursor,
            appendSpace: true
        }));
    }

    const modelMatch = beforeCursor.match(/^\s*\/model\s+([^\s]*)$/i);
    if (modelMatch) {
        const query = modelMatch[1] ?? "";
        const replaceStart = cursor - query.length;
        const trailingToken = input.line.slice(cursor).match(/^[^\s]*/)?.[0] ?? "";
        return rankMatches(input.models, query).slice(0, limit).map((item) => ({
            ...item,
            kind: "model",
            replaceStart,
            replaceEnd: cursor + trailingToken.length,
            appendSpace: true
        }));
    }

    const skillMatch = beforeCursor.match(/(?:^|\s)\$([a-z0-9-]*)$/i);
    if (skillMatch) {
        const query = skillMatch[1] ?? "";
        const replaceStart = cursor - query.length - 1;
        const trailingToken = input.line.slice(cursor).match(/^[a-z0-9-]*/i)?.[0] ?? "";
        const skills = input.skills.map((item) => ({
            ...item,
            value: item.value.startsWith("$") ? item.value : `$${item.value}`
        }));
        return rankMatches(skills, `$${query}`).slice(0, limit).map((item) => ({
            ...item,
            kind: "skill",
            replaceStart,
            replaceEnd: cursor + trailingToken.length,
            appendSpace: true
        }));
    }

    const trimmedStart = beforeCursor.trimStart();
    if (!trimmedStart.startsWith("/") || /\s/.test(trimmedStart)) return [];
    const leadingWhitespace = beforeCursor.length - trimmedStart.length;
    const trailingToken = input.line.slice(cursor).match(/^[^\s]*/)?.[0] ?? "";
    const matches = rankMatches(input.slashCommands, trimmedStart);
    return matches.slice(0, limit).map((item) => ({
        ...item,
        kind: "slash",
        replaceStart: leadingWhitespace,
        replaceEnd: cursor + trailingToken.length,
        appendSpace: item.value === "/model"
    }));
}

function applyInputSuggestion(line: string, suggestion: InputSuggestion): { line: string; cursor: number } {
    const suffix = suggestion.appendSpace && suggestion.replaceEnd === line.length ? " " : "";
    const nextLine = `${line.slice(0, suggestion.replaceStart)}${suggestion.value}${suffix}${line.slice(suggestion.replaceEnd)}`;
    return {
        line: nextLine,
        cursor: suggestion.replaceStart + suggestion.value.length + suffix.length
    };
}

function acceptInputSuggestion(
    line: string,
    cursor: number,
    suggestion: InputSuggestion,
    keyName: "enter" | "return" | "tab"
): InputSuggestionAcceptance {
    const applied = applyInputSuggestion(line, suggestion);
    const enterPressed = keyName === "enter" || keyName === "return";
    return {
        ...applied,
        submit: enterPressed && suggestion.kind === "slash" && !suggestion.appendSpace
    };
}

function moveSuggestionSelection(current: number, count: number, direction: -1 | 1): number {
    if (count <= 0) return 0;
    return (current + direction + count) % count;
}

function suggestionStateKey(suggestions: InputSuggestion[]): string {
    const first = suggestions[0];
    if (!first) return "";
    return `${first.kind}:${first.replaceStart}:${first.replaceEnd}:${suggestions.map((item) => item.value).join("\u0000")}`;
}

module.exports = {
    acceptInputSuggestion,
    applyInputSuggestion,
    buildInputSuggestions,
    moveSuggestionSelection,
    suggestionStateKey
};
