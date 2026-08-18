export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

/** @type {import('json-schema').JSONSchema} */
const FLAKY_SCHEMA = {
  type: 'object',
  properties: {
    testName: { type: 'string' },
    filePath: { type: 'string' },
    retryCount: { type: 'number' },
    reason: { type: 'string' }
  },
  required: ['testName', 'filePath'],
  additionalProperties: false
}

phase('Scan')
// The agent will look for common patterns of flakiness (e.g., "retry", "flaky", or multiple attempts in CI logs)
const raw_findings = await agent('Identify flaky tests by searching for retry markers, timeout errors, or inconsistent results in the CI/test logs. Provide a list of unique test files that exhibit this behavior.', {
  schema: FLAKY_SCHEMA,
  label: 'scan-flaky-tests'
}).then(res => res.filter(Boolean))

if (!raw_findings || raw_findings.length === 0) {
  log('No flaky tests identified.')
}

phase('Fix')
// We use pipeline to process each unique finding independently.
// Since one test might have multiple issues, we group by file/name first or just process the list.
const results = await pipeline(
  raw_findings,
  async (finding) => {
    return await agent(`The following test is identified as flaky: ${finding.testName} in ${finding.filePath}.
    Reasoning from logs: ${finding.reason || 'Detected via retry markers'}.

    Analyze the code in ${finding.filePath} and propose a specific fix for this flakiness (e.g., adding waits, ensuring proper cleanup, or removing non-deterministic logic).`, {
      label: `fix-${finding.testName.replace(/[^a-zA-Z0-9]/g, '')}`,
      phase: 'Fix'
    })
  }
)

log(`Analysis complete. Processed ${results.filter(Boolean).length} flaky tests.`)
