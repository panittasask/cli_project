function searchReturnedNoResults(output: string): boolean {
    // Search providers may report non-zero candidate counts per attempt while
    // the pipeline ultimately returns no usable results. Trust the pipeline's
    // final result object rather than those intermediate counts.
    return /"resultCount"\s*:\s*0\s*,\s*"evidenceQuality"\s*:\s*"insufficient"\s*,\s*"results"\s*:\s*\[\s*\]/i.test(output);
}

module.exports = {
    searchReturnedNoResults
};
