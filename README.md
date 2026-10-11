# Are.na MCP with PDF reading

A fork of [aredotna/mcp](https://github.com/aredotna/mcp) that lets MCP clients
read PDF attachments in Are.na, retrieve selected pages and cite the source.
All 52 existing Are.na tools and the upstream OAuth flow are retained. Two PDF
tools bring the total to 54.

The server supports **Vercel**, local **stdio**, and the original **Cloudflare
Workers** transport. Vercel is the preferred hosted setup for this fork; a
Cloudflare account is optional.

## Hosted endpoint and current status

The fork's stable MCP URL is:

```text
https://arena-mcp-tallevins-projects.vercel.app/mcp
```

Verified on **11 October 2026**:

| Item                 | Status                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Vercel deployment    | Running; [view project](https://vercel.com/tallevins-projects/arena-mcp)                                                     |
| PDF reading          | Live test returned all 21 pages and 33,317 characters of a private PDF, without truncation; targeted pages matched the cache |
| Tools                | All 54 available, including the original 52                                                                                  |
| Tests                | 61 passing; [GitHub checks](https://github.com/tallevin/arena-mcp/actions)                                                   |
| Durable hosted cache | Redis connected; a live PDF cache hit survived a production redeployment                                                     |
| OAuth sign-in        | Application credentials configured; live client registration and redirect to Are.na verified                                 |
| Production access    | Public HTTPS endpoint; Are.na authentication required for MCP calls; previews remain Vercel-protected                        |
| Hosted OCR           | Bundled English OCR on Vercel; opt-in through `ocr: "auto"` or `"force"`                                                     |

Live verification used the production URL without Vercel credentials. Redis
reads/writes, OAuth discovery, client registration and the exact registered
Are.na callback all passed. The account owner also reported a successful ChatGPT
connection and PDF retrieval; that client-side test was not independently repeated
by the deployment smoke test. Source and release history are
in [pull request #1](https://github.com/tallevin/arena-mcp/pull/1).

The official `https://mcp.are.na/mcp` endpoint runs the upstream server. Use this
fork's endpoint for the PDF tools. Keep an existing official connection available
until sign-in to the new endpoint is verified.

## Connect to ChatGPT

The existing Vercel deployment already has Redis and Are.na application
credentials configured. Add the endpoint as a separate custom MCP connection:

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button,
   and choose **Add custom MCP server**.
2. Use a name such as **Are.na PDF** and the description **Read Are.na channels
   and PDF attachments with page citations and cached page retrieval**.
3. Set the public server URL to
   `https://arena-mcp-tallevins-projects.vercel.app/mcp` and authentication to
   **OAuth**. Let the server register the client automatically; do not enter the
   Are.na application's client ID or secret into ChatGPT.
4. Review the connection prompt, create the plugin and complete Are.na sign-in
   and consent. Confirm that `read_pdf_block` and `get_pdf_pages` appear among
   the 54 discovered tools.
5. Start a new chat, select **Are.na PDF** with `@`, and ask it to read a PDF
   from one of your Are.na channels, citing page numbers. Follow up by requesting
   specific physical pages.

Account and workspace policies can affect custom MCP availability. These steps
follow [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server).
If sign-in fails, confirm that the Are.na application callback exactly matches
`https://arena-mcp-tallevins-projects.vercel.app/callback`, then inspect Vercel's
runtime logs. Avoid sharing credentials or complete OAuth redirect URLs.

## PDF tools

| Tool             | Use                                                                               |
| ---------------- | --------------------------------------------------------------------------------- |
| `read_pdf_block` | Download an accessible PDF block and extract text, optionally within a page range |
| `get_pdf_pages`  | Return selected physical pages, reusing cached extraction                         |

Example MCP tool calls:

```json
{"name":"read_pdf_block","arguments":{"block_id":12345}}
{"name":"read_pdf_block","arguments":{"block_id":12345,"start_page":2,"end_page":5}}
{"name":"get_pdf_pages","arguments":{"block_id":12345,"pages":[2,7,8]}}
{"name":"get_pdf_pages","arguments":{"block_id":12345,"pages":[7],"ocr":"auto","language":"eng"}}
```

Each page includes text, a 1-based physical page number, a printed label when
available, an Are.na citation and a PDF URL with `#page=N`. Retrieval uses physical
page numbers; printed labels can differ. Selected pages are sorted and deduplicated.

Both tools accept `refresh`, `max_chars`, `start_char`, `ocr` and `language`.
Responses default to a 100,000-character budget, with a maximum of 250,000.
Truncated text includes a `continuation` with the page and character offset;
resume through `get_pdf_pages`. Up to 50 explicit pages may be requested per call.

The first read downloads the complete PDF and extracts its native text. Selected
page reads return a subset of that extraction; they do not download individual
PDF byte ranges. Text extraction does not reconstruct diagrams or complex tables.
See [PDF tools, limits and OCR protocol](docs/pdf-tools.md) for full behavior.

### Full text and verbatim extraction

The PDF tools return the document's **full extracted wording**, without
summarising, paraphrasing or imposing a quotation-length limit. Each page's
`text` field contains the extraction output. Native PDF extraction can change
spacing, line breaks and reading order; OCR can misrecognise characters. This is
text extraction, not a byte-for-byte copy of the PDF or a reconstruction of its
layout.

To retrieve a complete document, call `read_pdf_block` without a page range. If
the response contains `continuation` or `omitted_pages`, retrieve the remainder
using the returned page and character offsets. Raising `max_chars` to 250,000
can reduce the number of calls; it does not remove the document safety limits.
See [complete-read instructions](docs/pdf-tools.md#complete-document-reads).

The MCP provides source text to its client. A chat application's rules can
separately limit what its assistant reproduces in a reply; changing this server
does not override those rules. Access to an Are.na block also does not establish
copyright ownership or a licence to reproduce its contents.

These two tools accept PDF attachment blocks. An ordinary web-link block is not
an input to the PDF extractor, and this fork does not add article-text fetching.

## Set up Vercel

For the existing deployment, open the [arena-mcp Vercel project](https://vercel.com/tallevins-projects/arena-mcp).
To deploy another instance, import this repository with framework **Hono**,
Node.js **24.x**, and the branch containing the PDF implementation. Leave build
settings at the framework defaults. The root `server.ts` exports the Hono app;
`vercel.json` selects the framework. The current project uses a 300-second timeout.

1. **Connect Upstash Redis** through the project's **Storage** tab and Vercel
   Marketplace. Choose the plan and region, then attach its environment variables
   to the deployment environment. The adapter accepts either pair below:

   | URL variable             | Token variable             |
   | ------------------------ | -------------------------- |
   | `UPSTASH_REDIS_REST_URL` | `UPSTASH_REDIS_REST_TOKEN` |
   | `KV_REST_API_URL`        | `KV_REST_API_TOKEN`        |

   OAuth state and PDF text use separate `arena:oauth` and `arena:pdf` prefixes.
   Use a private database or credentials scoped to this application. If the
   deployment integration lacks storage permissions, complete this step in
   Vercel's dashboard.

2. **Register an Are.na OAuth application** at
   [Are.na OAuth applications](https://www.are.na/developers/oauth/applications).
   For the existing deployment, set its callback to:

   ```text
   https://arena-mcp-tallevins-projects.vercel.app/callback
   ```

   Save `ARENA_OAUTH_CLIENT_ID` and `ARENA_OAUTH_CLIENT_SECRET` as Secret
   environment variables in Vercel for the deployment environment. Another
   instance needs its own stable hostname in the callback. A fork needs its own
   application credentials; upstream credentials are not included.

3. **Configure production access** under **Settings → Deployment Protection**.
   The MCP client must be able to reach production without signing in to Vercel.
   Review and authorize that access change; keep previews protected. Each MCP
   caller still requires Are.na authentication. The Vercel adapter ignores a
   server-wide `ARENA_ACCESS_TOKEN` fallback.

4. **Redeploy** after attaching storage and setting credentials. Check the root
   URL for `oauth_configured: true` and `durable_cache_configured: true`. These
   flags indicate configuration, not a successful database health check. Before
   setup is complete, OAuth routes return HTTP 503; bearer MCP requests can use
   a temporary memory cache.

5. **Verify and connect**. Confirm that unauthenticated `/mcp` requests receive
   an application-generated 401 with OAuth discovery metadata. With an Are.na
   token set privately as `ARENA_ACCESS_TOKEN` in your local environment, run:

   ```sh
   yarn smoke:pdf https://arena-mcp-tallevins-projects.vercel.app/mcp <pdf-block-id>
   ```

   Then connect that URL in your MCP client and complete Are.na sign-in. Hosted
   clients discover the OAuth endpoints and register automatically; the Are.na
   application ID and secret belong on the server.

## Local setup and clients

Use Node.js **22 or newer** and Yarn. Current CI and Vercel deployment use Node.js 24. Generated API tools are committed, so generation is not required to start.

```sh
git clone https://github.com/tallevin/arena-mcp.git
cd arena-mcp
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build
```

For local stdio, set `ARENA_ACCESS_TOKEN` privately in the environment and run
`yarn dev` for development. When configuring an MCP client, launch `tsx` directly
so package-manager output does not enter the stdio protocol:

```json
{
  "mcpServers": {
    "arena-pdf": {
      "command": "/absolute/path/arena-mcp/node_modules/.bin/tsx",
      "args": ["/absolute/path/arena-mcp/src/transports/stdio.ts"],
      "env": {
        "ARENA_ACCESS_TOKEN": "YOUR_ARENA_TOKEN"
      }
    }
  }
}
```

Replace the paths with your checkout's absolute paths. Configure the client's
working directory when supported, or set `PDF_CACHE_DIR` to an absolute location.
The default disk cache is `.cache/pdf` relative to the working directory.

Once hosted configuration is complete, remote clients use the fork's URL with
Streamable HTTP and OAuth. Clients that support bearer headers can also use an
Are.na personal access token. Tokens belong in private client configuration.

For Codex CLI, for example:

```toml
[mcp_servers.arena_pdf]
url = "https://arena-mcp-tallevins-projects.vercel.app/mcp"
```

Then run `codex mcp login arena_pdf`. Other remote clients use the same endpoint
and their supported authentication flow.

## Caching and authentication

Every PDF request checks current block access using the caller's token before
reading cached text. Cache keys hash the token, block ID and attachment metadata;
changed files, changed tokens and `refresh: true` invalidate the relevant result.
The Are.na API token is never sent to attachment download hosts.

PDF cache entries expire after seven days. Local stdio stores extracted text in
private disk files. Vercel stores it in Redis with versioned chunks for larger
entries; Cloudflare uses a separate KV binding. Without durable storage, HTTP
uses a bounded 16 MiB cache per instance. Raw PDFs and bearer tokens are not
persisted in the PDF cache. The separate OAuth store retains short-lived token
exchanges as required by the original authentication flow.

Downloads are restricted to approved Are.na attachment hosts, including every
redirect, and limited to 25 MiB. Extraction is limited to 500 pages and 5 million
characters, with a cooperative deadline. Hosting resource limits may impose
smaller practical limits. Concurrent cold requests in different instances can
repeat extraction.

## Optional OCR

OCR defaults to `off`. `auto` processes selected pages with fewer than 20
non-whitespace characters; `force` processes all selected pages. A sparse page
may be blank rather than scanned. OCR is limited to 20 pages per call and can
contain recognition errors.

- **Local OCR:** set `PDF_OCR=local`. Poppler's `pdftoppm`, Tesseract and the
  requested language data must already be installed. Optional path overrides are
  `PDF_POPPLER_PATH` and `PDF_TESSERACT_PATH`.
- **Vercel OCR:** English (`language: "eng"`) is included using PDFium and
  Tesseract WebAssembly. No extra provider, API key, system executable or runtime
  language download is needed. Processing stays within the existing server.
  Selected pages are rendered at up to 150 DPI, with a 3,000-pixel side limit.
  Each job has a hard 180-second deadline; at most two jobs run per process.
  OCR results use the existing seven-day cache. Set `PDF_OCR=off` and redeploy
  to disable the bundled provider.
- **External hosted OCR:** explicitly configure `PDF_OCR_ENDPOINT` and, if needed,
  `PDF_OCR_TOKEN`. The HTTPS provider receives the entire PDF, even for selected
  pages. There is no default third-party provider. An endpoint overrides Vercel's
  bundled engine and can support other languages. Cloudflare uses this adapter;
  its Workers runtime does not include the Node-only bundled engine.

For the image-only [Modern Monograms — Page 97](https://www.are.na/block/4617726)
block, request its first physical page:

```json
{
  "name": "get_pdf_pages",
  "arguments": {
    "block_id": 4617726,
    "pages": [1],
    "ocr": "auto",
    "language": "eng"
  }
}
```

The title's “Page 97” does not make it physical PDF page 97. Decorative monograms
may produce little or imperfect recognized text; OCR does not interpret graphics.

See [the OCR request/response protocol](docs/pdf-tools.md#local-setup-and-optional-ocr)
before connecting a hosted provider.

## Cloudflare alternative

The original HTTP transport remains available through `yarn dev:http` and
`yarn deploy`. Local Workers development uses ignored `.dev.vars` for credentials;
Wrangler supplies local KV storage.

For deployment, create your own `OAUTH_KV` and `PDF_CACHE` namespaces, replace the
placeholder IDs in `wrangler.toml`, and configure an Are.na OAuth application
for your worker's `/callback` URL. Store its credentials through Wrangler secrets.

The Cloudflare GitHub Actions deployment workflow is **manual**. It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, plus
separately configured Worker storage and OAuth credentials. Pushes to `main`
do not automatically run that workflow. Full instructions are in the
[Cloudflare setup guide](docs/pdf-tools.md#cloudflare-alternative).

## Development and verification

```sh
yarn typecheck
yarn test
yarn build
node --input-type=module -e 'await import("./dist/server.js")'
yarn wrangler deploy --dry-run
```

Tests cover PDF extraction, labels and citations, page selection, continuation,
access revocation, cache isolation and reuse, download restrictions, OCR, Redis
chunk handling, all tools, and a simulated PKCE OAuth round trip across instances.
Bundled OCR tests create real image-only PDFs without system executables, verify
selected-page recognition and cache reuse, and exercise worker timeouts. The
separate local OCR test requires Poppler/Tesseract; CI installs them. The compiled
Node startup check catches module-loading failures that TypeScript tests alone
may miss. `node dist/scripts/smoke-bundled-ocr.js` also checks the compiled worker
and bundled English assets.

To add a tool, register it under `src/tools/custom/` and add its registration to
`src/tools/index.ts`. When the Are.na API specification changes, `yarn generate`
updates generated types and tool registrations. Local module imports use `.js`
extensions so compiled files work in Node as well as bundled Workers builds.
Run `yarn format` to apply Prettier; staged files are also formatted by the
pre-commit hook.
