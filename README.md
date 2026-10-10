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

Verified on **10 October 2026**, using application commit `3d27ca3`:

| Item                 | Status                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Vercel deployment    | Running; [view deployment](https://vercel.com/tallevins-projects/arena-mcp/68JXgnW5GoL6Yg4VoMjp45nz3ZSk) |
| PDF reading          | Live test retrieved pages 1 and 2 of a private 21-page PDF with text and citations                       |
| Tools                | All 54 available, including the original 52                                                              |
| Tests                | 56 passing; [GitHub checks](https://github.com/tallevin/arena-mcp/actions/runs/38031409964)              |
| Durable hosted cache | Redis adapter implemented; Redis not yet connected                                                       |
| OAuth sign-in        | Application credentials not yet configured; OAuth routes return 503                                      |
| Production access    | Vercel login protection remains enabled; live tests used authorized temporary access                     |
| Hosted OCR           | Optional adapter implemented; no external provider configured                                            |

The live cache test reused the same server instance's memory cache. Durable
Redis persistence and an actual browser OAuth sign-in still need verification
following configuration. The current implementation is on `feature/pdf-retrieval`
in [draft pull request #1](https://github.com/tallevin/arena-mcp/pull/1);
`main` does not yet contain these changes.

The official `https://mcp.are.na/mcp` endpoint runs the upstream server. Use this
fork's endpoint for the PDF tools. Keep an existing official connection available
until sign-in to the new endpoint is verified.

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
git clone --branch feature/pdf-retrieval https://github.com/tallevin/arena-mcp.git
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
- **Hosted OCR:** explicitly configure `PDF_OCR_ENDPOINT` and, if needed,
  `PDF_OCR_TOKEN`. The HTTPS provider receives the entire PDF, even for selected
  pages. There is no default third-party provider. Hosted deployment does not
  include the local OCR executables.

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
The image-only OCR test requires Poppler/Tesseract; CI installs them. The compiled
Node startup check catches module-loading failures that TypeScript tests alone
may miss.

To add a tool, register it under `src/tools/custom/` and add its registration to
`src/tools/index.ts`. When the Are.na API specification changes, `yarn generate`
updates generated types and tool registrations. Local module imports use `.js`
extensions so compiled files work in Node as well as bundled Workers builds.
Run `yarn format` to apply Prettier; staged files are also formatted by the
pre-commit hook.
