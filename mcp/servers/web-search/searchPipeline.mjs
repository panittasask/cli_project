const stopWords = new Set(["the", "and", "for", "what", "with", "from", "คือ", "อะไร", "ของ", "ที่", "ใน", "ไหม", "หน่อย"]);

export function tokenize(value) {
    return (String(value || "").toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)+|[a-z0-9]{2,}|[\u0E00-\u0E7F]{2,}/g) || [])
        .filter((token) => !stopWords.has(token));
}

export function rewriteQueries(query) {
    const clean = String(query || "").replace(/\s+/g, " ").trim();
    const variants = [clean];
    const number = clean.match(/\b\d{2,}\b/)?.[0];
    if (number) {
        const supportingTerms = tokenize(clean).filter((token) => token !== number).slice(0, 4).join(" ");
        variants.push(`"${number}" ${supportingTerms}`);
    }
    if (/\bmeme\s*67\b|\b67\s*meme\b/i.test(clean)) {
        variants.push('"6-7" meme origin TikTok');
    }
    if (/[\u0E00-\u0E7F]/.test(clean)) {
        variants.push(`${clean} meaning origin context`);
    } else {
        variants.push(`${clean} meaning origin context`);
    }
    const withoutQuestionWords = clean.replace(/\b(what is|who is|how does)\b|(?:คืออะไร|หมายถึงอะไร|ช่วยหา|ค้นหา)/gi, " ").replace(/\s+/g, " ").trim();
    if (withoutQuestionWords && withoutQuestionWords !== clean) variants.push(withoutQuestionWords);
    return [...new Set(variants)].slice(0, 4);
}

export function scoreResult(query, result) {
    const queryTokens = new Set(tokenize(query));
    const resultTokens = new Set(tokenize(`${result.title || ""} ${result.snippet || ""} ${result.url || ""}`));
    let overlap = 0;
    for (const token of queryTokens) if (resultTokens.has(token)) overlap += 1;
    const minimumOverlap = queryTokens.size >= 3 ? 2 : 1;
    return overlap >= minimumOverlap ? overlap : 0;
}

export async function runSearchPipeline(query, maxResults, searchOnce) {
    const variants = rewriteQueries(query);
    const gathered = new Map();
    const attempts = [];

    for (const variant of variants) {
        const response = await searchOnce(variant, Math.min(10, Math.max(maxResults, 5)));
        attempts.push({ query: variant, provider: response.provider, resultCount: response.results.length });
        for (const result of response.results) {
            const relevanceScore = scoreResult(query, result);
            if (relevanceScore > 0 && result.url && !gathered.has(result.url)) {
                gathered.set(result.url, { ...result, relevanceScore });
            }
        }
        if (gathered.size >= Math.min(2, maxResults)) break;
    }

    const results = [...gathered.values()]
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, maxResults)
        .map((result, index) => ({ ...result, rank: index + 1 }));

    return {
        query,
        attempts,
        resultCount: results.length,
        evidenceQuality: results.length >= 2 ? "sufficient" : "insufficient",
        results
    };
}
