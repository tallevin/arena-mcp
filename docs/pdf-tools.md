# Are.na PDF tools

This fork extends `aredotna/mcp` at `59fe733b83dd7ca206364c638fe3b828a4d04111`.
It reuses the existing Are.na API client and each call's bearer token, and adds
two tools without replacing the generated tools, OAuth flow or composite tools.
The fork suits this task because upstream already supports custom tools and both
stdio and Cloudflare Workers HTTP transports. A companion would require another
authentication connection and duplicate API access. This fork also adds a Vercel
Hono entry point and a Redis adapter for durable OAuth state and PDF caching.

## Tool calls

```json
{"name":"read_pdf_block","arguments":{"block_id":12345}}
{"name":"get_pdf_pages","arguments":{"block_id":12345,"pages":[2,7,8]}}
{"name":"get_pdf_pages","arguments":{"block_id":12345,"pages":[7],"ocr":"auto","language":"eng"}}
```

`read_pdf_block` accepts `start_page` / `end_page`; `get_pdf_pages` accepts a list
of physical pages (up to 50). Pages are returned in ascending order without
duplicates. Both accept `refresh`, `max_chars`, `start_char`, `ocr`, and `language`.
OCR defaults to `off`; `auto` processes selected pages containing fewer than 20
non-whitespace characters, and `force` OCRs all selected pages. Blank or sparse
native-text pages are flagged `needs_ocr`; this flag can also describe a blank
page, and is not proof that the page is scanned.

Each page includes text, a 1-based physical page number, a printed `label` if
present, an Are.na citation, and an attachment URL with `#page=N`. Page labels may
be Roman numerals or restart at 1. Use physical numbers for retrieval and retain
labels when citing printed numbering. The tools extract text; they do not
reconstruct complex tables, diagrams, images or visual layout. OCR text can
contain recognition errors.

The default response budget is 100,000 characters (maximum 250,000). If a page
is cut short, `truncated` is true and `continuation` provides `page` and
`start_char`. Resume with `get_pdf_pages` selecting that page and copying the
offset. For a range that has more pages, `omitted_pages` lists what remains.
Keep the same OCR mode and language when resuming OCR text.

## Complete document reads

Both tools return extracted source text without summarising or paraphrasing it.
They do not apply a quotation-length or copyright filter. Native extraction may
normalise whitespace and reading order; OCR may introduce recognition errors.
The response budget limits one call, not the length of a document that can be
retrieved across calls, subject to the document limits below.

For a complete PDF, call `read_pdf_block` without `start_page` or `end_page`.
Use `max_chars: 250000` if a larger response is useful. When `continuation` is
present, call `read_pdf_block` again with `start_page` set to its `page` and
`start_char` set to its `start_char`. Preserve the original `end_page` if the
first request had one. Keep the same OCR mode and language. Continue until
`continuation` is null and `omitted_pages` is empty. Preserve the returned page
numbers when joining text; resumed text for a partial page belongs after that
page's earlier text.

For an explicit `get_pdf_pages` selection, resume using the original selection's
unfinished pages (up to 50 per call), starting with the continuation page and its
character offset. Do not restart at character zero when a page was only partly
returned, or the assembled text will repeat that page's opening.

The MCP returns source data; it does not grant reproduction rights or override
the connected assistant's output rules. Saving a PDF or link in Are.na does not
by itself establish copyright ownership. These tools require a PDF attachment
block; ordinary web-link article extraction is not implemented by this fork.

## Caching and download controls

Every request retrieves current block metadata with the caller's token **before**
using cached text. Keys hash the token, block ID, block/attachment modification
timestamps and URL. Changing the file or token produces a separate cache entry;
`refresh: true` bypasses cached extraction and selected OCR results. This prevents
one caller from reading another caller's cache and respects revoked access.

The first read downloads the whole attachment and extracts all native-text pages
once. Targeted reads return only the requested text and reuse that extraction;
they are not PDF byte-range downloads. OCR results are cached separately by
provider, language and page. Requesting uncached OCR may require another download.
Concurrent native extraction requests in one process/isolate share work.
Simultaneous cold requests in different instances can repeat extraction; the
service does not promise exactly-once processing. Cloudflare KV is eventually
consistent; Vercel Redis writes publish a complete version after its chunks exist.

Only approved Are.na attachment storage hosts are accepted, and every redirect
is checked. API tokens are never sent to attachment hosts. Downloads have a
30-second deadline and a 25 MiB limit that also applies to chunked responses.
Native extraction is sequential and limited to 500 pages, 5 million characters,
and a cooperative 30-second deadline checked between pages. An individual PDF.js
parse can block the event loop; this is not a hard CPU interrupt. The hosting
platform's CPU/memory limits can impose smaller practical document limits.
Unsupported or password-protected PDFs return an error rather than partial text.

Cache retention is seven days. stdio uses `.cache/pdf` (or `PDF_CACHE_DIR`) with
private file permissions and atomic writes; expired files are pruned on writes.
Cloudflare HTTP uses a separate `PDF_CACHE` KV binding. Vercel uses a dedicated
`arena:pdf` Redis prefix, with versioned chunks for large entries and automatic
expiry. Without persistent storage, HTTP uses a bounded 16 MiB in-memory cache
per instance, lost on restart. The PDF cache stores extracted text, not raw PDFs
or bearer tokens. The separate OAuth store retains short-lived token exchanges,
as in the original server; its credentials and contents must remain private.

## Local setup and optional OCR

Use Node.js 22 or newer:

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build
```

Run stdio with the existing `ARENA_ACCESS_TOKEN` environment variable. To enable
local OCR, set `PDF_OCR=local`; Poppler's `pdftoppm`, Tesseract and the requested
language data must already be installed. You can override their executable paths
using `PDF_POPPLER_PATH` / `PDF_TESSERACT_PATH`. No system packages are installed
automatically. Local OCR renders and recognizes at most 20 pages per call, with
bounded image dimensions and subprocess deadlines; temporary files are removed.
The test suite exercises actual image-only PDF OCR when those programs are
available, and skips that one test otherwise. CI installs them for this test.

Vercel includes a Node-only bundled provider: PDFium 3 renders pages and Tesseract.js
7 recognizes them using the packaged English dataset. Per-request OCR still defaults
to `off`; request `ocr: "auto"` or `"force"` and `language: "eng"`. No external
document transfer, system executables or runtime language downloads are required.
Other languages return a clear error. Set `PDF_OCR=off` to disable this provider.

The bundled engine renders at up to 150 DPI with a 3,000-pixel side limit and at
most nine million pixels per page. A worker processes at most 20 selected pages,
has a hard 180-second deadline and is terminated on completion or failure. At
most two jobs run per Node process; excess requests receive a retryable busy error.
The recognition engine, render settings and language are included in cache keys.
Raw PDF bytes and rendered images stay in memory and are not added to the cache.
Decorative lettering and complex visual layouts can produce imperfect OCR text.

An external provider remains optional for Vercel and is the hosted OCR option for
Cloudflare Workers. Configure `PDF_OCR_ENDPOINT` and optionally `PDF_OCR_TOKEN`;
an endpoint takes precedence over Vercel's bundled provider. The endpoint must be
HTTPS, accept a PDF body with `Content-Type: application/pdf`, `X-PDF-Pages`
(comma-separated physical numbers), and `X-OCR-Language`. It must return:

```json
{ "pages": [{ "page": 7, "text": "Recognized text" }] }
```

It receives the **whole PDF**, even for selected pages. Configure only a service
you intend to receive those documents; there is no default third-party provider.
Its bearer token is separate from the Are.na token. Redirects are disallowed,
responses are bounded to 8 MiB, and the request times out after 60 seconds.
The adapter is protocol-tested against a mock endpoint; no external OCR service
has been provisioned or tested by this change.

## Deploying on Vercel (preferred)

The root `server.ts` exports a Hono application for Vercel's Node.js runtime.
`vercel.json` selects Hono; the project uses a 300-second function ceiling. Existing stdio and
Cloudflare transports remain supported. Vercel does not need a Cloudflare account.

1. Import `tallevin/arena-mcp` into your Vercel team with framework **Hono**,
   Node.js **24.x**, and this fork's `main` branch. Leave build settings
   at the framework defaults: Vercel builds the Hono entry. The official upstream
   repository does not include this fork's PDF extension.
2. In the project's **Storage** tab, connect **Upstash Redis** through the
   [Vercel Marketplace](https://vercel.com/marketplace/upstash). Review the
   provider's plan and data region before accepting. The app accepts either
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the Marketplace's
   `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Redis stores separate `arena:oauth`
   and `arena:pdf` prefixes. It must be private to this app or use properly
   scoped credentials.
3. Register an application at
   [Are.na OAuth applications](https://www.are.na/developers/oauth/applications).
   Use the stable production callback `https://<your-vercel-host>/callback`.
   Save `ARENA_OAUTH_CLIENT_ID` and `ARENA_OAUTH_CLIENT_SECRET` as encrypted
   Vercel environment variables for the deployment environment. Do not add them
   to GitHub or chat. Upstream's OAuth credentials cannot be reused.
4. Redeploy after connecting storage and setting environment variables. The
   root response reports `oauth_configured` and `durable_cache_configured`.
   These flags describe configuration, not a successful storage health check.
   Until setup is complete, OAuth routes return an explicit 503. Bearer-token
   MCP requests remain available with temporary memory caching. The Vercel
   adapter always requires the caller's token and ignores a global
   `ARENA_ACCESS_TOKEN` fallback.
5. MCP clients must reach the endpoint without Vercel's separate login gate.
   Review **Settings → Deployment Protection** for the production URL. Keep
   preview deployments protected; use a production endpoint accessible to the
   MCP client. Are.na authentication still protects `/mcp` with a 401 challenge.
6. Run `yarn smoke:pdf https://<your-vercel-host>/mcp <pdf-block-id>` with an
   Are.na token privately set in your local environment. Confirm tool discovery,
   text extraction and a subsequent cache hit. Then connect the new `/mcp` URL
   in ChatGPT and complete Are.na sign-in. Keep the official connector until
   that browser OAuth round trip succeeds.

The Vercel integration can deploy the GitHub branch without adding a local
Vercel login. If its storage permissions are insufficient, connect Upstash in
Vercel's dashboard. The existing deployment has Redis connected and the Are.na
application credentials configured. Its production endpoint is public while
previews remain protected. English OCR is bundled into Vercel and requested per
tool call; no external OCR service is configured. The root also reports
`ocr_configured`, `ocr_provider` and `ocr_languages` (unknown for remote providers).

To connect the existing endpoint in ChatGPT, see the
[README's ChatGPT steps](../README.md#connect-to-chatgpt), based on
[OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server).

## Cloudflare alternative

To use the original Workers transport, sign in with `yarn wrangler login`, create
your own `OAUTH_KV` and `PDF_CACHE` namespaces, and replace the placeholder IDs
in `wrangler.toml`. Register the worker's `/callback` with your Are.na application
and store its client ID/secret using `yarn wrangler secret put <name>`. Run
`yarn wrangler deploy --dry-run`, then `yarn deploy`. Do not configure a shared
Are.na token on a public worker. Local `yarn dev:http` supplies local KV; browser
OAuth needs an appropriate local callback and credentials in ignored `.dev.vars`.

The Cloudflare GitHub deployment workflow is manual. It requires repository
secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, real namespace IDs and
separately configured Worker OAuth secrets. Existing OAuth behavior is retained,
not independently audited or redesigned by this work.

## Verification performed

- Real multi-page PDF fixtures: extraction, printed labels, citations, blanks,
  selected pages, truncation and resumption.
- Cache reuse, token isolation, access revocation, updated attachments, refresh,
  concurrent misses, memory bounds, KV expiry and local disk persistence.
- Attachment URL/redirect restrictions, missing signatures, HTTP failures and
  size/page limits; optional OCR modes, language caches and endpoint validation.
- Existing HTTP/OAuth tests and real MCP SDK tool calls, including HTTP bearer
  propagation and omission of API credentials from CDN requests.
- Actual local Poppler/Tesseract recognition of an image-only scanned PDF.
- Actual bundled OCR of selected pages from image-only PDFs, cached recognition,
  preserved citations, hard worker termination and concurrency limits.
- A real private 21-page Are.na PDF through the local Cloudflare Workers runtime:
  physical pages 1 and 2 returned text and citations; the second read hit KV cache.
- Redis namespace isolation, expiry settings, large entry chunking, concurrent
  writes and incomplete/failed chunk handling.
- Vercel discovery, authentication challenges, all 54 tools, and a simulated
  complete PKCE OAuth round trip across independent handler instances.
- Live production checks without Vercel credentials: OAuth discovery returns
  200, unauthenticated MCP requests return 401, and preview URLs redirect to
  Vercel sign-in.
- Live Vercel reading of a private 21-page Are.na PDF: physical pages 1 and 2
  returned text and citations. The Redis cache hit survived a redeployment.
- Live dynamic OAuth client registration and authorization redirect to Are.na,
  including the exact production callback and a configured provider client.
- TypeScript checks, compiled Node.js server startup, build and Cloudflare deployment dry run.

The account owner reported successful account access and PDF retrieval through
the new ChatGPT connection. The deployment smoke tests independently verify live
bearer access and Redis persistence; browser consent and token exchange were not
independently repeated. The external OCR adapter remains mock-tested and has no
provider configured.
