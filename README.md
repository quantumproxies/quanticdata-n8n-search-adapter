# QuanticData web search adapter for n8n Assistant

Connect QuanticData SERP search to the **SearXNG provider setting in self-hosted n8n Assistant**. This small Node.js service translates the HTTP request and result fields. It requires no community node and no n8n source changes.

This is a QuanticData integration, not an official n8n plugin or a complete SearXNG implementation. Tested with n8n **2.45.7**, its installed `@n8n/ai-utilities` client and the real QuanticData API on 1 November 2026 (UTC).

## Tutorial

- [Step-by-step setup article on QuanticData](https://quanticdata.io/blog/n8n-assistant-web-search-quanticdata/)
- [English video tutorial](https://www.youtube.com/watch?v=ZIiuu05goPc)
- [Source and download](https://github.com/quantumproxies/quanticdata-n8n-search-adapter)

## How it works

```text
n8n Assistant
  GET /search?q=...&format=json&pageno=1
  -> private adapter container
  POST https://api.quanticdata.io/v1/scraper/serp
  -> QuanticData
  payload.organic -> results[{title,url,content}]
  -> n8n search results
```

The adapter returns search snippets and links. It does not fetch the linked pages or generate answers. Search queries are sent to QuanticData and the configured search engine. Keeping the adapter local does not make web searches offline or keep query contents entirely on your machine.

Every response includes the provider attribution **Search API by quanticdata.io**. Because n8n's SearXNG client discards extra top-level fields, a separately labelled provider credit is also appended to the first result's snippet. The credit identifies the search service, not the author of the linked page. No synthetic search result is added, and there is no instruction to the model to promote or cite a product. Whether an Assistant includes the credit in its final answer is up to that Assistant.

## Quick setup: Windows, macOS and Linux

Requires **Node.js 22+**, **Docker running Linux containers**, an existing **n8n container**, and your **QuanticData API key**. On Windows and macOS, start Docker Desktop first; on Linux, start Docker Engine and use an account with Docker access. Download the [version 0.1.0 source ZIP](https://github.com/quantumproxies/quanticdata-n8n-search-adapter/releases/download/v0.1.0/quanticdata-n8n-search-adapter-0.1.0.zip), or use these commands to download, extract and start setup. macOS and Linux commands require `curl` and `unzip`.

**Windows — PowerShell**

```powershell
New-Item -ItemType Directory -Force "$HOME\quanticdata-n8n-install" | Out-Null
Set-Location "$HOME\quanticdata-n8n-install"
Invoke-WebRequest "https://github.com/quantumproxies/quanticdata-n8n-search-adapter/releases/download/v0.1.0/quanticdata-n8n-search-adapter-0.1.0.zip" -OutFile adapter.zip
Expand-Archive adapter.zip -DestinationPath .
Set-Location quanticdata-n8n-search-adapter
node setup.mjs
```

**macOS — Terminal**

```sh
mkdir -p "$HOME/quanticdata-n8n-install"
cd "$HOME/quanticdata-n8n-install"
curl -fL "https://github.com/quantumproxies/quanticdata-n8n-search-adapter/releases/download/v0.1.0/quanticdata-n8n-search-adapter-0.1.0.zip" -o adapter.zip
unzip adapter.zip
cd quanticdata-n8n-search-adapter
node setup.mjs
```

**Linux — terminal**

```sh
mkdir -p "$HOME/quanticdata-n8n-install"
cd "$HOME/quanticdata-n8n-install"
curl -fL "https://github.com/quantumproxies/quanticdata-n8n-search-adapter/releases/download/v0.1.0/quanticdata-n8n-search-adapter-0.1.0.zip" -o adapter.zip
unzip adapter.zip
cd quanticdata-n8n-search-adapter
node setup.mjs
```

Adjust the directory to where you extracted the archive. Paste your API key when prompted; it is not echoed. The installer finds n8n, builds the adapter, protects a key file under your home directory and connects the new container to n8n's network. It does not restart n8n or publish a host port.

Finally, open **n8n Assistant > Web search > SearXNG**, paste **`http://quanticdata-search:8080`**, and save. Test a public documentation query. That's the complete quick path.

For multiple n8n containers, add `--n8n CONTAINER`. For multiple networks, add `--network NETWORK`. `node setup.mjs --check` performs detection without changing anything. An existing adapter is left in place. Native, non-Docker n8n installations need the manual setup below. Windows deployment was tested; macOS/Linux commands use the same Node/Docker interfaces, but full installs on those operating systems have not been tested on real hosts.

## Manual Docker setup with an existing n8n instance

1. Obtain a QuanticData API key from your [QuanticData account](https://app.quanticdata.io/).
2. Copy `.env.example` to `.env`, set `QUANTICDATA_API_KEY`, and restrict access to the file. Never commit it. QuanticData API usage is subject to your account's access, credit and limits; the adapter's MIT license does not make API requests unlimited or free.
3. Add the service from `compose.example.yaml` to your n8n Compose project. Set `build.context` to the adapter directory and `env_file` to the actual `.env` location. Both services must share a Docker network. Do not add public `ports` to the adapter.
4. Start only the new service:

```sh
docker compose up -d --build --no-deps quanticdata-search
```

5. In n8n's Assistant settings, open **Web search**, choose **SearXNG**, and set **Instance URL** to:

```text
http://quanticdata-search:8080
```

6. Save and run the connection test. Ask the Assistant to search for a public documentation page and check its links. The label in n8n remains **SearXNG** because that is the compatibility interface.

The model provider and code sandbox must already be configured. This adapter supplies only web search. `localhost` inside the n8n container means the n8n container, not this service or your PC.

Alternatively, set `N8N_INSTANCE_AI_SEARXNG_URL=http://quanticdata-search:8080` in n8n's environment and recreate **n8n** when you are ready. Check for an existing Brave configuration: n8n gives Brave priority when both environment providers are configured. Prefer saving the SearXNG connection through the UI to avoid a restart. See the [n8n Assistant setup documentation](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant#enable-web-search).

For Docker secrets, set `QUANTICDATA_API_KEY_FILE=/run/secrets/quanticdata_search_key` and mount a Compose secret containing only the key. A key file takes precedence over `QUANTICDATA_API_KEY`. Never mount the Docker socket or n8n's data volume into this adapter.

## Run without Docker

Node.js 22 or later is required. There are no npm dependencies.

```sh
# Set QUANTICDATA_API_KEY in your environment, then:
npm start
```

The standalone process binds to `127.0.0.1:8080` by default. The container binds to `0.0.0.0:8080` inside its private network. If n8n is in Docker and the adapter runs on the host, configure networking explicitly; the Compose arrangement above is the tested installation.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QUANTICDATA_API_KEY` | required unless a key file is set | QuanticData bearer key |
| `QUANTICDATA_API_KEY_FILE` | unset | File containing the key; takes precedence |
| `QUANTICDATA_ENGINE` | `google` | `google`, `bing`, or `duckduckgo` |
| `QUANTICDATA_LANG` | `en` | Search language |
| `QUANTICDATA_COUNTRY` | unset | Optional two-letter country code |
| `UPSTREAM_TIMEOUT_MS` | `25000` | Request deadline; keep below n8n's connection-test deadline |
| `MAX_CONCURRENT_SEARCHES` | `4` | Simultaneous calls before returning HTTP 429 |
| `HOST` | `127.0.0.1` | Container sets this to `0.0.0.0` |
| `PORT` | `8080` | Listen port |

Google was used for live integration testing. The other engine names are accepted by QuanticData's SERP endpoint but were not benchmarked by this project.

## Protocol and limits

- `GET /healthz`: process health, without a paid upstream call. It does not verify the key or account balance.
- `GET /search`: accepts `q` (required, up to 2,048 characters), `format=json` and `pageno` from 1 to 99. Other parameters, repeated parameters, and non-GET requests are rejected.
- Requests ten organic results per search; the upstream may return fewer. n8n chooses how many to keep. Ads and other SERP blocks are not mapped.
- Search operators are passed through unchanged. Their interpretation and domain filtering are the selected engine's responsibility.
- No SearXNG HTML UI, POST search, categories, image search, per-request language, date filtering, authentication layer or public multi-user gateway.
- No adapter cache and no automatic retries. Timeout or disconnection cancellation cannot guarantee cancellation of upstream work or billing.
- No query, credential or upstream-body logging. Logs contain status, result count and elapsed time. HTTP redirects are rejected; credentials go only to the fixed QuanticData endpoint.
- The listener has **no authentication**. Keep it on a trusted private network. Do not expose it publicly without a separately designed authenticated gateway and usage controls.

## Testing and troubleshooting

```sh
npm test
```

Tests cover request conversion, result normalization, empty and malformed responses, credential/billing/rate errors, response size limits, timeout recovery and concurrency. To test the actual client installed in the standard n8n Docker image:

```sh
docker cp scripts/verify-n8n.cjs YOUR_N8N_CONTAINER:/tmp/verify-quanticdata-search.cjs
docker exec YOUR_N8N_CONTAINER node /tmp/verify-quanticdata-search.cjs
```

This performs a real QuanticData search and can consume API credit. It exits unsuccessfully if results are empty or invalid.

| Failure | Check |
| --- | --- |
| Cannot reach the adapter | Same Docker network, service name, container health |
| `upstream_auth_failed` / `upstream_access_denied` | QuanticData key and API access |
| `upstream_billing_required` | QuanticData account balance or billing state |
| HTTP 429 | Adapter concurrency or upstream account limits |
| `upstream_timeout` | Upstream response deadline; don't raise it beyond n8n's own deadline without checking both |
| `invalid_upstream_response` | API shape or a malformed response; this is not a successful empty search |

To roll back, select your previous provider or disable web search in n8n, then stop `quanticdata-search`. The adapter stores no persistent data and does not modify workflows.

## Release status

Download source packages and checksums from [GitHub Releases](https://github.com/quantumproxies/quanticdata-n8n-search-adapter/releases). The installer builds the Docker image locally; no public registry image or npm installation is required. MIT licensed.
