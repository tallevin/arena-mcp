# Are.na PDF tools

This fork extends `aredotna/mcp` at `59fe733b83dd7ca206364c638fe3b828a4d04111`.
It reuses the existing Are.na API client and each call's bearer token, and adds
two tools without replacing the generated tools, OAuth flow or composite tools.
The fork suits this task because upstream already supports custom tools and both
stdio and Cloudflare Workers HTTP transports. A companion would require another
authentication connection and duplicate API access. Vercel would require a new
runtime adapter and durable OAuth storage; it is not the deployment target here.

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
Concurrent native extraction requests in one process/isolate share work. KV is
eventually consistent, so simultaneous cold requests in different regions can
repeat extraction; the service does not promise exactly-once processing.

Only approved Are.na attachment storage hosts are accepted, and every redirect
is checked. API tokens are never sent to attachment hosts. Downloads have a
30-second deadline and a 25 MiB limit that also applies to chunked responses.
Native extraction is sequential and limited to 500 pages, 5 million characters,
and a cooperative 30-second deadline checked between pages. An individual PDF.js
parse can block the event loop; this is not a hard CPU interrupt. Workers'
platform CPU/memory limits can impose smaller practical document limits.
Unsupported or password-protected PDFs return an error rather than partial text.

Cache retention is seven days. stdio uses `.cache/pdf` (or `PDF_CACHE_DIR`) with
private file permissions and atomic writes; expired files are pruned on writes.
HTTP uses a separate `PDF_CACHE` KV binding, with automatic expiry. Without KV,
HTTP uses a bounded 16 MiB in-memory cache per isolate, lost on restart.
Only extracted text is persisted; raw PDFs and bearer tokens are not stored.

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

Hosted Workers cannot execute native programs. To enable hosted OCR, explicitly
configure `PDF_OCR_ENDPOINT` and optionally `PDF_OCR_TOKEN`. The endpoint must be
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

## Deploying your fork

Deployment requires your Cloudflare account, its own KV namespaces, and an Are.na
OAuth application for the new server. Upstream OAuth credentials and storage are
not available to forks. GitHub authorisation does not grant those credentials.

1. Sign in with `yarn wrangler login` (or supply a scoped Cloudflare API token and
   `CLOUDFLARE_ACCOUNT_ID`). Create `OAUTH_KV` and `PDF_CACHE` with
   `yarn wrangler kv namespace create <binding>`, then put their IDs in
   `wrangler.toml`. The checked-in IDs are placeholders, not upstream resources.
2. Register an application at
   [Are.na OAuth applications](https://www.are.na/developers/oauth/applications).
   Its callback must be `https://<your-worker-host>/callback`.
3. Set `ARENA_OAUTH_CLIENT_ID` and `ARENA_OAUTH_CLIENT_SECRET` using
   `yarn wrangler secret put <name>`. Keep them out of git. For a publicly
   accessible deployment, authenticate each caller; do not configure a shared
   `ARENA_ACCESS_TOKEN` fallback.
4. Run `yarn wrangler deploy --dry-run`, then `yarn deploy`. The worker name is
   `tallevin-arena-mcp`; its final hostname depends on your Cloudflare account.
5. Check OAuth discovery and the 401 challenge without a token. With a token set
   privately in the environment, run
   `yarn smoke:pdf https://<your-worker-host>/mcp <pdf-block-id>` to check tool
   discovery, extraction and a subsequent cache hit. Then complete the OAuth
   connection in your MCP client, using the new `/mcp` URL.

Local Workers development (`yarn dev:http`) supplies local KV automatically.
For end-to-end browser OAuth locally, use an OAuth application callback of
`http://127.0.0.1:8787/callback` and credentials in ignored `.dev.vars`.

The GitHub deployment workflow is manual to prevent a fork from deploying before
its storage and OAuth configuration are ready. For CI deployment, set repository
secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, update the namespace IDs,
and run the Deploy workflow on the intended branch. Worker OAuth secrets are
configured separately using Wrangler. Keep the existing official Are.na connector
until the new endpoint's OAuth round trip is verified. The existing authentication
implementation is retained, not independently audited or redesigned by this work.

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
- A real private 21-page Are.na PDF through the local Cloudflare Workers runtime:
  physical pages 1 and 2 returned text and citations; the second read hit KV cache.
- TypeScript checks, build and Cloudflare deployment dry run.

Hosted Cloudflare deployment and a browser OAuth round trip on the new hostname
remain unverified until the account/application steps above are completed.
