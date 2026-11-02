import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAdapter, loadConfig, ATTRIBUTION } from '../src/server.mjs';

const config = loadConfig({ QUANTICDATA_API_KEY: 'private-test-key' });
const fixture = { type: 'response', payload: { organic: [
  { title: 'n8n docs', link: 'https://docs.n8n.io/', description: 'Workflow automation documentation.' },
  { title: 'Second result', url: 'https://example.org/path', snippet: 'Another snippet.' },
] } };

async function serve(t, fetchImpl, overrides = {}) {
  const logs = [];
  const server = createAdapter({ ...config, ...overrides }, { fetchImpl, log: e => logs.push(e) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { logs, get: path => fetch(base + path), base };
}

test('n8n SearXNG request becomes an authenticated SERP call with usable results', async t => {
  let captured;
  const app = await serve(t, async (url, options) => {
    captured = { url, ...options, body: JSON.parse(options.body) };
    return Response.json(fixture);
  });
  const query = 'n8n (site:docs.n8n.io OR site:n8n.io) -site:example.com';
  const r = await app.get('/search?' + new URLSearchParams({ q: query, format: 'json', pageno: '1' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(captured.url, 'https://api.quanticdata.io/v1/scraper/serp');
  assert.equal(captured.headers.Authorization, 'Bearer private-test-key');
  assert.equal(captured.redirect, 'error');
  assert.deepEqual(captured.body, { query, page: 1, engine: 'google', num: 10, lang: 'en' });
  assert.deepEqual(await r.json(), { query, results: [
    { title: 'n8n docs', url: 'https://docs.n8n.io/', content: 'Workflow automation documentation.\n\n[Search provider attribution: Search API by quanticdata.io]' },
    { title: 'Second result', url: 'https://example.org/path', content: 'Another snippet.' },
  ], attribution: ATTRIBUTION });
  assert.ok(!JSON.stringify(app.logs).includes(query));
  assert.ok(!JSON.stringify(app.logs).includes('private-test-key'));
});

test('invalid requests and health checks never call the paid upstream', async t => {
  let calls = 0;
  const app = await serve(t, () => { calls++; throw Error('unexpected'); });
  for (const path of ['/search', '/search?q=x&pageno=0', '/search?q=x&format=html', '/search?q=a&q=b', '/search?q=x&url=http://localhost', '/search?q=%00', '/search?q=' + 'x'.repeat(2049)]) {
    assert.equal((await app.get(path)).status, 400, path);
  }
  assert.equal((await app.get('/healthz')).status, 200);
  assert.equal((await app.get('/other')).status, 404);
  assert.equal((await fetch(app.base + '/search?q=x', { method: 'POST' })).status, 405);
  assert.equal(calls, 0);
});

test('upstream credentials, billing and rate errors are explicit and sanitized', async t => {
  for (const [status, expected, code] of [[401, 502, 'upstream_auth_failed'], [402, 502, 'upstream_billing_required'], [403, 502, 'upstream_access_denied'], [429, 429, 'upstream_rate_limited'], [500, 502, 'upstream_request_failed']]) {
    const app = await serve(t, async () => new Response('private-test-key secret upstream body', { status }));
    const r = await app.get('/search?q=test');
    assert.equal(r.status, expected);
    assert.deepEqual(await r.json(), { error: code, attribution: ATTRIBUTION });
    assert.ok(!JSON.stringify(app.logs).includes('private-test-key'));
  }
});

test('malformed envelopes are errors, genuine empty organic arrays remain empty', async t => {
  for (const payload of [{ type: 'error', payload: { organic: [] } }, { type: 'response', payload: {} }, {}]) {
    const app = await serve(t, async () => Response.json(payload));
    assert.equal((await app.get('/search?q=test')).status, 502);
  }
  const app = await serve(t, async () => Response.json({ type: 'response', payload: { organic: [] } }));
  assert.deepEqual(await (await app.get('/search?q=test')).json(), { query: 'test', results: [], attribution: ATTRIBUTION });
});

test('filters unsafe links and duplicates while preserving result order', async t => {
  const app = await serve(t, async () => Response.json({ type: 'response', payload: { organic: [
    null, { title: 'bad', link: 'javascript:alert(1)' }, { title: 'bad', link: 'https://user:pass@example.com' },
    fixture.payload.organic[0], fixture.payload.organic[0], fixture.payload.organic[1],
  ] } }));
  const data = await (await app.get('/search?q=test')).json();
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].title, 'n8n docs');
});

test('bounded response and malformed JSON fail without leaking upstream text', async t => {
  for (const value of ['not-json private-test-key', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const app = await serve(t, async () => new Response(value));
    const r = await app.get('/search?q=test');
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('private-test-key'));
  }
});

test('concurrency cap rejects additional requests and recovers after a timeout', async t => {
  const app = await serve(t, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 100, maxConcurrent: 1 });
  const first = app.get('/search?q=one');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await app.get('/search?q=two')).status, 429);
  assert.equal((await first).status, 504);
  assert.equal((await app.get('/search?q=three')).status, 504);
});

test('network failures are sanitized', async t => {
  const app = await serve(t, async () => { throw new Error('private-test-key'); });
  const r = await app.get('/search?q=test');
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'upstream_unavailable', attribution: ATTRIBUTION });
});

test('startup validates secrets and configuration', () => {
  for (const env of [{}, { QUANTICDATA_API_KEY: 'a\nb' }, { QUANTICDATA_API_KEY: 'x', PORT: 'oops' }, { QUANTICDATA_API_KEY: 'x', QUANTICDATA_ENGINE: 'unknown' }]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({ QUANTICDATA_API_KEY: 'x' }).host, '127.0.0.1');
});
