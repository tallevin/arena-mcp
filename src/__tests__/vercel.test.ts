import { afterEach, describe, expect, it, vi } from "vitest";
import { createVercelHandler } from "../transports/vercel.js";
import { RedisKv } from "../pdf/redis.js";

function redisMock() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _options: { ex: number }) => {
      values.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      values.delete(key);
      return 1;
    }),
  };
}
const origin = "https://arena-test.vercel.app";
function request(path: string, body?: object) {
  return new Request(
    origin + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Redis storage", () => {
  it("keeps OAuth/PDF namespaces separate and preserves string serialization and TTLs", async () => {
    const redis = redisMock();
    const oauth = new RedisKv(redis, "oauth");
    const pdf = new RedisKv(redis, "pdf");
    await oauth.put("same", '{"nested":true}', { expirationTtl: 300 });
    await pdf.put("same", "PDF text");
    expect(await oauth.get("same")).toBe('{"nested":true}');
    expect(await pdf.get("same")).toBe("PDF text");
    expect(redis.set.mock.calls[0][2]).toEqual({ ex: 300 });
    expect(redis.set.mock.calls[1][2]).toEqual({ ex: 604800 });
    await oauth.delete("same");
    expect(await oauth.get("same")).toBe(null);
    expect(await pdf.get("same")).toBe("PDF text");
  });

  it("reassembles large text across instances and treats a missing chunk as a cache miss", async () => {
    const redis = redisMock();
    const text = 'PDF \"text\" ☃\n'.repeat(16000);
    await new RedisKv(redis, "pdf").put("document", text);
    expect(redis.set.mock.calls.length).toBeGreaterThan(3);
    expect(await new RedisKv(redis, "pdf").get("document")).toBe(text);
    const chunk = [...redis.values.keys()].find((key) =>
      key.includes(":chunk:"),
    )!;
    redis.values.delete(chunk);
    expect(await new RedisKv(redis, "pdf").get("document")).toBe(null);
  });

  it("publishes one complete revision when large writes overlap", async () => {
    const redis = redisMock();
    const kv = new RedisKv(redis, "pdf");
    const a = "a".repeat(180000),
      b = "b".repeat(200000);
    await Promise.all([kv.put("doc", a), kv.put("doc", b)]);
    expect([a, b]).toContain(await kv.get("doc"));
  });

  it("retains an existing revision when a replacement chunk write fails", async () => {
    const redis = redisMock();
    const kv = new RedisKv(redis, "pdf");
    await kv.put("doc", "old");
    redis.set.mockImplementationOnce(async () => {
      throw new Error("network unavailable");
    });
    await expect(kv.put("doc", "new".repeat(60000))).rejects.toThrow();
    expect(await kv.get("doc")).toBe("old");
  });
});

describe("Vercel transport", () => {
  it("exposes current-origin discovery and blocks incomplete OAuth configuration", async () => {
    const handle = createVercelHandler({});
    const root = await (await handle(request("/"))).json();
    expect(root).toMatchObject({
      hosting: "vercel",
      oauth_configured: false,
      durable_cache_configured: false,
      ocr_configured: true,
      ocr_provider: "bundled",
      ocr_languages: ["eng"],
      url: origin + "/mcp",
    });
    const discovery = (await (
      await handle(request("/.well-known/oauth-authorization-server"))
    ).json()) as { issuer: string };
    expect(discovery.issuer).toBe(origin);
    for (const path of ["/register", "/authorize", "/callback", "/token"]) {
      expect((await handle(request(path, {}))).status).toBe(503);
    }
    expect((await handle(request("/mcp", {}))).status).toBe(401);
  });

  it("never inherits a shared Are.na token from the environment", async () => {
    const handle = createVercelHandler({
      ARENA_ACCESS_TOKEN: "shared-token",
    } as never);
    expect((await handle(request("/mcp", {}))).status).toBe(401);
  });

  it("allows operators to disable bundled OCR or select an external provider", async () => {
    const disabled = await (
      await createVercelHandler({ PDF_OCR: "off" })(request("/"))
    ).json();
    expect(disabled).toMatchObject({
      ocr_configured: false,
      ocr_provider: null,
      ocr_languages: [],
    });
    const remote = await (
      await createVercelHandler({
        PDF_OCR_ENDPOINT: "https://ocr.example/recognize",
      })(request("/"))
    ).json();
    expect(remote).toMatchObject({
      ocr_configured: true,
      ocr_provider: "remote",
      ocr_languages: null,
    });
  });

  it("preserves all tools in authenticated MCP discovery", async () => {
    const handle = createVercelHandler({});
    const response = await handle(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = JSON.parse(text.split("data: ")[1].split("\n")[0]);
    expect(data.result.tools).toHaveLength(54);
    expect(
      data.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(
      expect.arrayContaining(["getBlock", "read_pdf_block", "get_pdf_pages"]),
    );
  });

  it("completes PKCE OAuth across independently created handlers", async () => {
    const redis = redisMock();
    const environment = {
      ARENA_OAUTH_CLIENT_ID: "arena-app",
      ARENA_OAUTH_CLIENT_SECRET: "arena-secret",
    };
    const handler = () =>
      createVercelHandler(environment, {
        oauth: new RedisKv(redis, "oauth"),
        pdf: new RedisKv(redis, "pdf"),
      });
    const redirect = "https://client.example/callback";
    const registered = (await (
      await handler()(request("/register", { redirect_uris: [redirect] }))
    ).json()) as { client_id: string };
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const params = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "client-state",
      scope: "read",
    });
    const authorize = await handler()(request("/authorize?" + params));
    expect(authorize.status).toBe(302);
    const upstream = new URL(authorize.headers.get("Location")!);
    expect(upstream.searchParams.get("redirect_uri")).toBe(
      origin + "/callback",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "per-user-token" })),
    );
    const callback = await handler()(
      request(
        "/callback?" +
          new URLSearchParams({
            code: "arena-code",
            state: upstream.searchParams.get("state")!,
          }),
      ),
    );
    const clientRedirect = new URL(callback.headers.get("Location")!);
    expect(clientRedirect.searchParams.get("state")).toBe("client-state");
    const tokenRequest = () =>
      new Request(origin + "/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: clientRedirect.searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: redirect,
        }),
      });
    const result = await handler()(tokenRequest());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      access_token: "per-user-token",
      token_type: "Bearer",
      scope: "read",
    });
    expect((await handler()(tokenRequest())).status).toBe(400);
  });
});
