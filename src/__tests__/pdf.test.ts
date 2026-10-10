import { describe, it, expect, vi, afterEach } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { PdfService, type PdfBlock } from "../pdf/service.js";
import { extractPdf } from "../pdf/extract.js";
import {
  downloadPdf,
  validateAttachmentUrl,
  MAX_PDF_BYTES,
} from "../pdf/download.js";
import { MemoryPdfCache, KvPdfCache } from "../pdf/cache.js";
import { RemoteOcrProvider } from "../pdf/remote-ocr.js";
import app from "../transports/http.js";

afterEach(() => vi.unstubAllGlobals());

async function fixture(
  texts = ["First page evidence", "Second page reference", ""],
) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = pdf.addPage([400, 500]);
    if (text) page.drawText(text, { x: 30, y: 450, size: 16, font });
  }
  pdf.catalog.set(
    PDFName.of("PageLabels"),
    pdf.context.obj({
      Nums: [0, { S: "r" }, 1, { S: "D", St: 1 }],
    }),
  );
  return pdf.save();
}

const block: PdfBlock = {
  id: 42,
  title: "Research PDF",
  updated_at: "2026-10-10T00:00:00Z",
  attachment: {
    url: "https://attachments.are.na/42/research.pdf",
    content_type: "application/pdf",
  },
};

async function makeService(
  options: ConstructorParameters<typeof PdfService>[0] = {},
) {
  const bytes = await fixture();
  const fetchBlock = vi.fn(async () => block);
  const download = vi.fn(async () => bytes);
  const extract = vi.fn(extractPdf);
  return {
    service: new PdfService({ fetchBlock, download, extract, ...options }),
    fetchBlock,
    download,
    extract,
  };
}

describe("real PDF extraction and retrieval", () => {
  it("preserves page boundaries, printed labels, citations and blank scan flags", async () => {
    const { service } = await makeService();
    const result = await service.read("alice", { block_id: 42 });
    expect(result.total_pages).toBe(3);
    expect(result.pages.map((p) => p.text)).toEqual([
      "First page evidence",
      "Second page reference",
      "",
    ]);
    expect(result.pages.map((p) => p.label)).toEqual(["i", "1", "2"]);
    expect(result.pages[1].pdf_url).toMatch(/#page=2$/);
    expect(result.pages[1].citation).toContain("PDF page 2");
    expect(result.pages[2].needs_ocr).toBe(true);
  });

  it("rejects malformed PDFs and enforces the page limit", async () => {
    await expect(
      extractPdf(new TextEncoder().encode("not pdf")),
    ).rejects.toThrow();
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 501; i++) pdf.addPage();
    await expect(extractPdf(await pdf.save())).rejects.toThrow(
      "500 page limit",
    );
  });

  it("returns only requested pages and reuses extraction", async () => {
    const { service, download, extract, fetchBlock } = await makeService();
    await service.read("alice", { block_id: 42 });
    const result = await service.read("alice", {
      block_id: 42,
      pages: [3, 2, 2],
    });
    expect(result.pages.map((p) => p.page)).toEqual([2, 3]);
    expect(result.cache_hit).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fetchBlock).toHaveBeenCalledTimes(2);
  });

  it("isolates tokens and rechecks permission before a cache hit", async () => {
    const { service, download, fetchBlock } = await makeService();
    await service.read("alice", { block_id: 42 });
    await service.read("bob", { block_id: 42 });
    expect(download).toHaveBeenCalledTimes(2);
    fetchBlock.mockRejectedValueOnce(
      new Error("Cannot access Are.na block (HTTP 403)"),
    );
    await expect(service.read("alice", { block_id: 42 })).rejects.toThrow(
      "403",
    );
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("invalidates updated attachments and supports refresh", async () => {
    const { service, fetchBlock, download } = await makeService();
    await service.read("alice", { block_id: 42 });
    fetchBlock.mockResolvedValueOnce({ ...block, updated_at: "2026-10-11" });
    await service.read("alice", { block_id: 42 });
    await service.read("alice", { block_id: 42, refresh: true });
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent cache misses", async () => {
    const { service, download, extract } = await makeService();
    await Promise.all([
      service.read("alice", { block_id: 42 }),
      service.read("alice", { block_id: 42 }),
    ]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("reports truncation and resumes a page without losing characters", async () => {
    const { service } = await makeService();
    const first = await service.read("alice", { block_id: 42, max_chars: 5 });
    expect(first.pages[0].text).toBe("First");
    expect(first.continuation).toEqual({ page: 1, start_char: 5 });
    const rest = await service.read("alice", {
      block_id: 42,
      pages: [1],
      start_char: 5,
    });
    expect(first.pages[0].text + rest.pages[0].text).toBe(
      "First page evidence",
    );
    expect(first.omitted_pages).toEqual([2, 3]);
    const range = await service.read("alice", {
      block_id: 42,
      start_page: 2,
      end_page: 3,
    });
    expect(range.pages.map((p) => p.page)).toEqual([2, 3]);
  });

  it("rejects missing auth, non PDFs, oversized attachments and invalid pages", async () => {
    const { service, fetchBlock, download } = await makeService();
    await expect(service.read("", { block_id: 42 })).rejects.toThrow(
      "Authentication",
    );
    expect(fetchBlock).not.toHaveBeenCalled();
    fetchBlock.mockResolvedValueOnce({ id: 42 });
    await expect(service.read("alice", { block_id: 42 })).rejects.toThrow(
      "PDF attachment",
    );
    fetchBlock.mockResolvedValueOnce({
      ...block,
      attachment: { ...block.attachment!, file_size: MAX_PDF_BYTES + 1 },
    });
    await expect(service.read("alice", { block_id: 42 })).rejects.toThrow(
      "25 MiB",
    );
    expect(download).not.toHaveBeenCalled();
    await expect(
      service.read("alice", { block_id: 42, pages: [4] }),
    ).rejects.toThrow("between 1 and 3");
    await expect(
      service.read("alice", { block_id: 42, start_page: 3, end_page: 1 }),
    ).rejects.toThrow("Page numbers");
    await expect(
      service.read("alice", { block_id: 42, start_char: 1000 }),
    ).rejects.toThrow("start_char");
  });
});

describe("bounded attachment downloads", () => {
  it.each([
    "http://attachments.are.na/file.pdf",
    "https://localhost/file.pdf",
    "https://127.0.0.1/file.pdf",
    "https://[::1]/file.pdf",
    "https://attachments.are.na.evil.test/a.pdf",
    "https://u:p@attachments.are.na/a.pdf",
    "https://s3.amazonaws.com/other-bucket/a.pdf",
    "https://attachments.are.na:444/a.pdf",
  ])("rejects %s", (url) => {
    expect(() => validateAttachmentUrl(url)).toThrow();
  });

  it("validates redirects and never forwards API credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        }),
    );
    await expect(downloadPdf(block.attachment!.url, fetcher)).rejects.toThrow(
      "approved",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty(
      "headers.Authorization",
    );
  });

  it("downloads a real fixture; rejects spoofed PDFs, HTTP errors and oversized responses", async () => {
    const bytes = await fixture();
    const fetcher = vi.fn(async () => new Response(bytes.slice().buffer));
    expect(await downloadPdf(block.attachment!.url, fetcher)).toEqual(bytes);
    await expect(
      downloadPdf(
        block.attachment!.url,
        async () => new Response("<html>login</html>"),
      ),
    ).rejects.toThrow("signature");
    await expect(
      downloadPdf(
        block.attachment!.url,
        async () => new Response(null, { status: 403 }),
      ),
    ).rejects.toThrow("403");
    await expect(
      downloadPdf(
        block.attachment!.url,
        async () =>
          new Response("", {
            headers: { "content-length": String(MAX_PDF_BYTES + 1) },
          }),
      ),
    ).rejects.toThrow("25 MiB");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PDF_BYTES + 1));
        controller.close();
      },
    });
    await expect(
      downloadPdf(block.attachment!.url, async () => new Response(stream)),
    ).rejects.toThrow("25 MiB");
  });
});

describe("optional OCR", () => {
  it("does not OCR by default; auto OCRs only sparse selected pages and caches results", async () => {
    const recognize = vi.fn(async (_bytes: Uint8Array, pages: number[]) =>
      Object.fromEntries(pages.map((p) => [p, "Scanned page evidence"])),
    );
    const { service, download } = await makeService({
      ocr: { id: "test", recognize },
    });
    await service.read("alice", { block_id: 42 });
    expect(recognize).not.toHaveBeenCalled();
    const result = await service.read("alice", {
      block_id: 42,
      pages: [3],
      ocr: "auto",
    });
    expect(recognize.mock.calls[0][1]).toEqual([3]);
    expect(result.pages[0].extraction).toBe("ocr");
    expect(result.pages[0].needs_ocr).toBe(false);
    await service.read("alice", { block_id: 42, pages: [3], ocr: "auto" });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
    const resumed = await service.read("alice", {
      block_id: 42,
      pages: [3],
      ocr: "auto",
      start_char: 8,
    });
    expect(resumed.pages[0].text).toBe("page evidence");
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when requested OCR is unavailable or incomplete", async () => {
    const { service } = await makeService();
    await expect(
      service.read("alice", { block_id: 42, pages: [3], ocr: "auto" }),
    ).rejects.toThrow("no provider");
    const incomplete = await makeService({
      ocr: { id: "bad", recognize: async () => ({}) },
    });
    await expect(
      incomplete.service.read("alice", {
        block_id: 42,
        pages: [3],
        ocr: "force",
      }),
    ).rejects.toThrow("omitted page 3");
  });

  it("supports force mode and separates language caches", async () => {
    const recognize = vi.fn(async () => ({ 2: "OCR replacement" }));
    const { service } = await makeService({ ocr: { id: "test", recognize } });
    const result = await service.read("alice", {
      block_id: 42,
      pages: [2],
      ocr: "force",
    });
    expect(result.pages[0].text).toBe("OCR replacement");
    await service.read("alice", {
      block_id: 42,
      pages: [2],
      ocr: "force",
      language: "fra",
    });
    expect(recognize).toHaveBeenCalledTimes(2);
    await service.read("alice", { block_id: 42, refresh: true });
    await service.read("alice", { block_id: 42, pages: [2], ocr: "force" });
    expect(recognize).toHaveBeenCalledTimes(3);
  });

  it("uses only the configured remote OCR token and validates responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ pages: [{ page: 2, text: "OCR output" }] }),
    );
    const provider = new RemoteOcrProvider(
      "https://ocr.example.test/read",
      "ocr-only-secret",
      fetcher,
    );
    expect(await provider.recognize(await fixture(), [2], "eng")).toEqual({
      2: "OCR output",
    });
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer ocr-only-secret", "X-PDF-Pages": "2" },
    });
    expect(() => new RemoteOcrProvider("http://ocr.example.test/read")).toThrow(
      "HTTPS",
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ pages: [{ page: 99, text: "invalid" }] }),
    );
    await expect(
      provider.recognize(await fixture(), [2], "eng"),
    ).rejects.toThrow("invalid page");
  });
});

describe("cache storage", () => {
  it("bounds memory and expires entries", async () => {
    const cache = new MemoryPdfCache(10);
    await cache.put("a", "12345");
    await cache.put("b", "67890");
    await cache.get("a");
    await cache.put("c", "abcde");
    expect(await cache.get("b")).toBeNull();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 8 * 86400_000);
    expect(await cache.get("a")).toBeNull();
    now.mockRestore();
  });

  it("writes KV with seven day TTL", async () => {
    const put = vi.fn();
    const cache = new KvPdfCache({
      put,
      get: async () => "entry",
    } as unknown as KVNamespace);
    await cache.put("key", "value");
    expect(put).toHaveBeenCalledWith("key", "value", { expirationTtl: 604800 });
    expect(await cache.get("key")).toBe("entry");
  });
});

describe("MCP protocol integration", () => {
  it("preserves existing tools and validates PDF arguments with the real SDK", async () => {
    const { service } = await makeService();
    const server = createMcpServer(service);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "pdf-test", version: "1" });
    await server.connect(serverTransport);
    const original = serverTransport.onmessage!;
    serverTransport.onmessage = (message, extra) =>
      original(message, {
        ...extra,
        authInfo: { token: "alice", clientId: "test", scopes: [] },
      });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "getBlock",
          "channelDigest",
          "searchAndConnect",
          "read_pdf_block",
          "get_pdf_pages",
        ]),
      );
      const result = await client.callTool({
        name: "get_pdf_pages",
        arguments: { block_id: 42, pages: [2] },
      });
      const content = result.content as Array<{ text: string }>;
      expect(JSON.parse(content[0].text).pages[0].text).toBe(
        "Second page reference",
      );
      const invalid = await client.callTool({
        name: "get_pdf_pages",
        arguments: { block_id: 42, pages: [0] },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes HTTP bearer auth to the API and uses KV across server instances", async () => {
    const bytes = await fixture();
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace;
    const env = {
      OAUTH_KV: kv,
      PDF_CACHE: kv,
      ARENA_OAUTH_CLIENT_ID: "test",
      ARENA_OAUTH_CLIENT_SECRET: "test",
    };
    const requests: Request[] = [];
    const fetcher: typeof fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return request.url.startsWith("https://api.are.na/")
          ? Response.json(block)
          : new Response(bytes.slice().buffer);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const call = async (id: number) => {
      const response = await app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer http-test-token",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "get_pdf_pages",
              arguments: { block_id: 42, pages: [2] },
            },
          }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      const raw = await response.text();
      const json = raw.startsWith("{")
        ? JSON.parse(raw)
        : JSON.parse(
            raw
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6),
          );
      expect(json.result.isError).not.toBe(true);
      return JSON.parse(json.result.content[0].text);
    };
    expect((await call(1)).cache_hit).toBe(false);
    expect((await call(2)).cache_hit).toBe(true);
    expect(
      requests
        .filter((r) => r.url.startsWith("https://api.are.na/"))
        .map((r) => r.headers.get("Authorization")),
    ).toEqual(["Bearer http-test-token", "Bearer http-test-token"]);
    const downloads = requests.filter(
      (r) => !r.url.startsWith("https://api.are.na/"),
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0].headers.has("Authorization")).toBe(false);
  });
});
