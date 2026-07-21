export type SearchResult = { rank: number; title: string; snippet: string; url: string; source: string };

export function htmlToText(value: string): string;
export function extractBingSearchResults(html: string, maxResults: number): SearchResult[];
export function searchBingHtml(query: string, maxResults: number): Promise<{ provider: string; results: SearchResult[] }>;
export function searchBingRss(query: string, maxResults: number): Promise<{ provider: string; results: SearchResult[] }>;
