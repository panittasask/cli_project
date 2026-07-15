export type SearchResult = {
    rank?: number;
    title?: string;
    snippet?: string;
    url: string;
    source?: string;
    relevanceScore?: number;
};

export function tokenize(value: string): string[];
export function rewriteQueries(query: string): string[];
export function scoreResult(query: string, result: SearchResult): number;
export function runSearchPipeline(
    query: string,
    maxResults: number,
    searchOnce: (query: string, maxResults: number) => Promise<{ provider: string; results: SearchResult[] }>
): Promise<{
    query: string;
    attempts: Array<{ query: string; provider: string; resultCount: number }>;
    resultCount: number;
    evidenceQuality: "sufficient" | "insufficient";
    results: SearchResult[];
}>;
