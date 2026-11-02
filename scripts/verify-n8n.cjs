const { createRequire } = require('node:module');
const requireN8n = createRequire('/usr/local/lib/node_modules/n8n/package.json');
(async () => {
  const { searxngSearch } = await import(requireN8n.resolve('@n8n/ai-utilities'));
  const start = Date.now();
  const result = await searxngSearch(process.env.ADAPTER_URL || 'http://quanticdata-search:8080', 'n8n workflow automation', {
    maxResults: 10,
    abortSignal: AbortSignal.timeout(30000),
  });
  const attributionPresent = result.results[0]?.snippet.includes('[Search provider attribution: Search API by quanticdata.io]') ?? false;
  const valid = attributionPresent && result.results.length > 0 && result.results.every(r => r.title && /^https?:\/\//.test(r.url) && typeof r.snippet === 'string');
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), client: '@n8n/ai-utilities', resultCount: result.results.length, valid, attributionPresent, elapsedMs: Date.now() - start }, null, 2));
  if (!valid) process.exitCode = 1;
})().catch(() => { console.error('n8n search integration check failed'); process.exitCode = 1; });
