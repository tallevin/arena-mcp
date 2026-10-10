import type { OcrProvider } from "./service";

/** An operator-selected endpoint; disabled unless explicitly configured. */
export class RemoteOcrProvider implements OcrProvider {
  readonly id: string;

  constructor(
    private endpoint: string,
    private token?: string,
    private fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(
        "PDF_OCR_ENDPOINT must be an HTTPS URL without credentials",
      );
    }
    this.id = `remote-v1:${url.href}`;
  }

  async recognize(bytes: Uint8Array, pages: number[], language: string) {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/pdf",
        "X-PDF-Pages": pages.join(","),
        "X-OCR-Language": language,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: bytes.slice().buffer,
    });
    if (!response.ok)
      throw new Error(`OCR endpoint failed (HTTP ${response.status})`);
    // Bound the response before parsing JSON, including chunked responses.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OCR endpoint returned no body");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("OCR response exceeds the 8 MiB limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const payload = JSON.parse(new TextDecoder().decode(data)) as {
      pages?: Array<{ page: number; text: string }>;
    };
    if (!Array.isArray(payload.pages))
      throw new Error("OCR endpoint must return a pages array");
    const result: Record<number, string> = {};
    for (const entry of payload.pages) {
      if (!pages.includes(entry.page) || typeof entry.text !== "string") {
        throw new Error("OCR endpoint returned an invalid page");
      }
      result[entry.page] = entry.text;
    }
    return result;
  }
}
