import type { StringKv } from "../auth/kv.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpServer } from "../server.js";
import { oauthRoutes } from "../auth/routes.js";
import { PdfService } from "../pdf/service.js";
import { KvPdfCache } from "../pdf/cache.js";
import { RemoteOcrProvider } from "../pdf/remote-ocr.js";

export interface Env {
  ARENA_ACCESS_TOKEN?: string;
  OAUTH_KV: StringKv;
  ARENA_OAUTH_CLIENT_ID: string;
  ARENA_OAUTH_CLIENT_SECRET: string;
  PDF_CACHE?: StringKv;
  PDF_OCR_ENDPOINT?: string;
  PDF_OCR_TOKEN?: string;
}

const pdfServices = new WeakMap<
  object,
  { signature: string; service: PdfService }
>();
function pdfService(env: Env): PdfService | undefined {
  if (!env.PDF_CACHE && !env.PDF_OCR_ENDPOINT) return undefined;
  const identity = env.PDF_CACHE ?? env.OAUTH_KV;
  const signature = JSON.stringify([env.PDF_OCR_ENDPOINT, env.PDF_OCR_TOKEN]);
  const existing = pdfServices.get(identity);
  if (existing?.signature === signature) return existing.service;
  const service = new PdfService({
    cache: env.PDF_CACHE ? new KvPdfCache(env.PDF_CACHE) : undefined,
    ocr: env.PDF_OCR_ENDPOINT
      ? new RemoteOcrProvider(env.PDF_OCR_ENDPOINT, env.PDF_OCR_TOKEN)
      : undefined,
  });
  pdfServices.set(identity, { signature, service });
  return service;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    name: "@aredotna/mcp",
    version: "0.1.0",
    transport: "streamable-http",
    endpoint: "/mcp",
    url: `${new URL(c.req.url).origin}/mcp`,
    docs: "https://github.com/aredotna/mcp",
  });
});

// OAuth 2.1 routes (metadata, DCR, authorize, callback, token)
app.route("/", oauthRoutes);

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function unauthorized(c: Context<{ Bindings: Env }>) {
  const origin = new URL(c.req.url).origin;
  return c.json(
    { error: "Unauthorized", message: "Bearer token required" },
    401,
    {
      "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  );
}

app.get("/mcp", (c) => {
  const token = extractBearerToken(c.req.raw) ?? c.env.ARENA_ACCESS_TOKEN;
  if (!token) return unauthorized(c);

  return c.json(
    { error: "Method Not Allowed", message: "Use POST for MCP requests" },
    405,
  );
});

app.post("/mcp", async (c) => {
  const token = extractBearerToken(c.req.raw) ?? c.env.ARENA_ACCESS_TOKEN;

  if (!token) {
    return unauthorized(c);
  }

  const authInfo: AuthInfo = {
    token,
    clientId: "http",
    scopes: [],
  };

  const server = createMcpServer(pdfService(c.env));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  return transport.handleRequest(c.req.raw, { authInfo });
});

app.delete("/mcp", async (c) => {
  return c.json({ message: "Session ended" }, 200);
});

export default app;
