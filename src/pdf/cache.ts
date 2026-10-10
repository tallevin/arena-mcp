import type { StringKv } from "../auth/kv";
/** Cache entries contain extracted text, never bearer tokens or raw PDFs. */
export interface PdfCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export class MemoryPdfCache implements PdfCache {
  private entries = new Map<string, { value: string; expires: number }>();
  private bytes = 0;

  constructor(private maxBytes = 16 * 1024 * 1024) {}

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.remove(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async put(key: string, value: string) {
    const size = new TextEncoder().encode(value).byteLength;
    this.remove(key);
    if (size > this.maxBytes) return;
    while (this.bytes + size > this.maxBytes && this.entries.size) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, {
      value,
      expires: Date.now() + CACHE_TTL_SECONDS * 1000,
    });
    this.bytes += size;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= new TextEncoder().encode(entry.value).byteLength;
    this.entries.delete(key);
  }
}

export class KvPdfCache implements PdfCache {
  constructor(private kv: StringKv) {}

  get(key: string) {
    return this.kv.get(key);
  }

  async put(key: string, value: string) {
    await this.kv.put(key, value, { expirationTtl: CACHE_TTL_SECONDS });
  }
}
