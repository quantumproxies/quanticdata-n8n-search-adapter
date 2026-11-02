import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.quanticdata.io/v1/scraper/serp';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const ATTRIBUTION = Object.freeze({ text: 'Search API by quanticdata.io', url: 'https://quanticdata.io/' });
const CREDIT = '\n\n[Search provider attribution: Search API by quanticdata.io]';

class SearchError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}

export function loadConfig(env = process.env) {
  const apiKey = (env.QUANTICDATA_API_KEY_FILE
    ? readFileSync(env.QUANTICDATA_API_KEY_FILE, 'utf8')
    : env.QUANTICDATA_API_KEY ?? '').trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('A valid QuanticData API key is required');
  const engine = env.QUANTICDATA_ENGINE ?? 'google';
  if (!['google', 'bing', 'duckduckgo'].includes(engine)) throw new Error('Invalid QUANTICDATA_ENGINE');
  const lang = env.QUANTICDATA_LANG ?? 'en';
  const country = env.QUANTICDATA_COUNTRY || undefined;
  if (!/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(lang)) throw new Error('Invalid QUANTICDATA_LANG');
  if (country && !/^[a-zA-Z]{2}$/.test(country)) throw new Error('Invalid QUANTICDATA_COUNTRY');
  return {
    apiKey, engine, lang, country,
    host: env.HOST ?? '127.0.0.1',
    port: integer(env.PORT, 8080, 1, 65535, 'PORT'),
    timeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 25000, 100, 90000, 'UPSTREAM_TIMEOUT_MS'),
    maxConcurrent: integer(env.MAX_CONCURRENT_SEARCHES, 4, 1, 32, 'MAX_CONCURRENT_SEARCHES'),
  };
}

function parseSearch(url) {
  const supported = new Set(['q', 'format', 'pageno']);
  for (const key of url.searchParams.keys()) {
    if (!supported.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new SearchError(400, 'unsupported_or_duplicate_parameter');
  }
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query || query.length > 2048 || /[\u0000-\u001f\u007f]/.test(query))
    throw new SearchError(400, 'invalid_query');
  if (url.searchParams.has('format') && url.searchParams.get('format') !== 'json')
    throw new SearchError(400, 'json_format_required');
  const pageText = url.searchParams.get('pageno') ?? '1';
  if (!/^[1-9]\d?$/.test(pageText)) throw new SearchError(400, 'invalid_page');
  return { query, page: Number(pageText) };
}

async function readJson(response) {
  if (!response.body) throw new SearchError(502, 'invalid_upstream_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SearchError(502, 'upstream_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SearchError) throw error;
    throw new SearchError(502, 'invalid_upstream_response');
  } finally {
    reader.releaseLock();
  }
}

export function mapResults(body, query) {
  // The live QuanticData REST API wraps SERP results in payload.
  const data = body?.payload;
  if (body?.type !== 'response' || !Array.isArray(data?.organic))
    throw new SearchError(502, 'invalid_upstream_response');
  const seen = new Set();
  const results = [];
  for (const item of data.organic) {
    if (!item || typeof item !== 'object') continue;
    const link = item.link ?? item.url;
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    if (typeof item.title !== 'string' || !item.title.trim() || seen.has(url.href)) continue;
    seen.add(url.href);
    const snippet = item.description ?? item.snippet ?? '';
    results.push({
      title: item.title,
      url: url.href,
      content: typeof snippet === 'string' ? snippet : '',
    });
  }
  if (data.organic.length && !results.length) throw new SearchError(502, 'invalid_upstream_results');
  // n8n discards extra top-level fields. Keep one explicitly labelled provider
  // credit in the first snippet too, without adding a fabricated search result.
  if (results.length) results[0].content += CREDIT;
  return { query, results, attribution: ATTRIBUTION };
}

function send(response, status, body, extraHeaders = {}) {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify({ ...body, attribution: ATTRIBUTION }));
}

export function createAdapter(config, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const start = Date.now();
    let counted = false;
    const controller = new AbortController();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', onClose);
    let timeout;
    try {
      if (request.method !== 'GET') {
        send(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      const url = new URL(request.url, 'http://adapter.local');
      if (url.pathname === '/healthz') {
        send(response, 200, { status: 'ok' });
        return;
      }
      if (url.pathname !== '/search') throw new SearchError(404, 'not_found');
      const { query, page } = parseSearch(url);
      if (active >= config.maxConcurrent) throw new SearchError(429, 'search_capacity_reached');
      active++;
      counted = true;
      timeout = setTimeout(() => controller.abort(new Error('upstream_timeout')), config.timeoutMs);
      const upstream = await fetchImpl(ENDPOINT, {
        method: 'POST',
        // Never forward credentials through a redirect, even to another HTTPS host.
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, page, engine: config.engine, num: 10, lang: config.lang, ...(config.country ? { country: config.country } : {}) }),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const code = { 401: 'upstream_auth_failed', 403: 'upstream_access_denied', 402: 'upstream_billing_required', 429: 'upstream_rate_limited' }[upstream.status] ?? 'upstream_request_failed';
        throw new SearchError(upstream.status === 429 ? 429 : 502, code);
      }
      const data = await readJson(upstream);
      if (controller.signal.aborted) throw new SearchError(504, 'upstream_timeout');
      const result = mapResults(data, query);
      send(response, 200, result);
      log({ event: 'search_complete', status: 200, resultCount: result.results.length, elapsedMs: Date.now() - start });
    } catch (error) {
      const failure = controller.signal.aborted ? new SearchError(504, 'upstream_timeout')
        : error instanceof SearchError ? error : new SearchError(502, 'upstream_unavailable');
      send(response, failure.status, { error: failure.code }, failure.status === 429 ? { 'Retry-After': '5' } : {});
      log({ event: 'search_failed', status: failure.status, code: failure.code, elapsedMs: Date.now() - start });
    } finally {
      clearTimeout(timeout);
      response.removeListener('close', onClose);
      if (counted) active--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const log = event => console.log(JSON.stringify(event));
    const server = createAdapter(config, { log });
    server.on('error', () => { console.error('Adapter listener failed'); process.exitCode = 1; });
    server.listen(config.port, config.host, () => log({ event: 'ready', port: config.port, engine: config.engine }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
  } catch {
    console.error('Adapter configuration is invalid. Check the API key and documented environment variables.');
    process.exitCode = 1;
  }
}
