import { Redis } from "@upstash/redis";
import type { StringKv } from "../auth/kv.js";
import httpApp, { type Env } from "./http.js";
import { RedisKv } from "../pdf/redis.js";
import { BundledOcrProvider } from "../pdf/bundled-ocr.js";

export interface VercelEnvironment {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  ARENA_OAUTH_CLIENT_ID?: string;
  ARENA_OAUTH_CLIENT_SECRET?: string;
  PDF_OCR_ENDPOINT?: string;
  PDF_OCR_TOKEN?: string;
  PDF_OCR?: "off" | "bundled";
}

/** Shares upstream HTTP/OAuth routes; never enables a server-wide Are.na token. */
export function createVercelHandler(
  environment: VercelEnvironment,
  storage?: { oauth: StringKv; pdf: StringKv },
) {
  const url = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const token =
    environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  if (!storage && url && token) {
    const redis = new Redis({ url, token, automaticDeserialization: false });
    storage = {
      oauth: new RedisKv(redis, "arena:oauth"),
      pdf: new RedisKv(redis, "arena:pdf"),
    };
  }
  const unavailable: StringKv = {
    get: async () => {
      throw new Error("OAuth storage is not configured");
    },
    put: async () => {
      throw new Error("OAuth storage is not configured");
    },
    delete: async () => {
      throw new Error("OAuth storage is not configured");
    },
  };
  const oauthConfigured = !!(
    storage &&
    environment.ARENA_OAUTH_CLIENT_ID &&
    environment.ARENA_OAUTH_CLIENT_SECRET
  );
  const env: Env = {
    OAUTH_KV: storage?.oauth ?? unavailable,
    PDF_CACHE: storage?.pdf,
    ARENA_OAUTH_CLIENT_ID: environment.ARENA_OAUTH_CLIENT_ID ?? "",
    ARENA_OAUTH_CLIENT_SECRET: environment.ARENA_OAUTH_CLIENT_SECRET ?? "",
    PDF_OCR_ENDPOINT: environment.PDF_OCR_ENDPOINT,
    PDF_OCR_TOKEN: environment.PDF_OCR_TOKEN,
    PDF_OCR_PROVIDER:
      environment.PDF_OCR === "off" ? undefined : new BundledOcrProvider(),
  };
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      ["/register", "/authorize", "/callback", "/token"].includes(path) &&
      !oauthConfigured
    ) {
      return Response.json(
        {
          error: "temporarily_unavailable",
          error_description:
            "Configure Redis storage and an Are.na OAuth application before connecting with OAuth.",
        },
        { status: 503 },
      );
    }
    const response = await httpApp.fetch(request, env);
    if (path === "/" && response.ok) {
      return Response.json({
        ...((await response.json()) as object),
        docs: "https://github.com/tallevin/arena-mcp",
        hosting: "vercel",
        oauth_configured: oauthConfigured,
        durable_cache_configured: !!storage,
        ocr_configured: !!(env.PDF_OCR_ENDPOINT || env.PDF_OCR_PROVIDER),
        ocr_provider: env.PDF_OCR_ENDPOINT
          ? "remote"
          : env.PDF_OCR_PROVIDER
            ? "bundled"
            : null,
        ocr_languages: env.PDF_OCR_ENDPOINT
          ? null
          : env.PDF_OCR_PROVIDER
            ? ["eng"]
            : [],
      });
    }
    return response;
  };
}
