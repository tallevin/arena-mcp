import { createArenaClient } from "../client.js";
import { MemoryPdfCache, type PdfCache } from "./cache.js";
import {
  downloadPdf,
  MAX_PDF_BYTES,
  validateAttachmentUrl,
} from "./download.js";
import { extractPdf, type ExtractedPage } from "./extract.js";

export interface PdfBlock {
  id: number;
  title?: string | null;
  updated_at?: string;
  attachment?: {
    url: string;
    filename?: string | null;
    content_type?: string | null;
    file_extension?: string | null;
    file_size?: number | null;
    updated_at?: string | null;
  };
}

export interface OcrProvider {
  /** Change this ID when changing OCR engine or settings to invalidate cache. */
  id: string;
  recognize(
    bytes: Uint8Array,
    pages: number[],
    language: string,
  ): Promise<Record<number, string>>;
}

export interface PdfReadOptions {
  block_id: number;
  pages?: number[];
  start_page?: number;
  end_page?: number;
  max_chars?: number;
  /** Resume an explicitly truncated page at this character offset. */
  start_char?: number;
  refresh?: boolean;
  ocr?: "off" | "auto" | "force";
  language?: string;
}

interface CachedDocument {
  pages: ExtractedPage[];
  extracted_at: string;
  revision: string;
}

interface ServiceOptions {
  cache?: PdfCache;
  ocr?: OcrProvider;
  fetchBlock?: (token: string, id: number) => Promise<PdfBlock>;
  download?: typeof downloadPdf;
  extract?: typeof extractPdf;
}

export async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchBlock(token: string, id: number): Promise<PdfBlock> {
  const { data, error, response } = await createArenaClient(token).GET(
    "/v3/blocks/{id}",
    {
      params: { path: { id } },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (error || !data)
    throw new Error(`Cannot access Are.na block (HTTP ${response.status})`);
  return data as PdfBlock;
}

export class PdfService {
  private cache: PdfCache;
  private inFlight = new Map<
    string,
    Promise<{ doc: CachedDocument; bytes: Uint8Array }>
  >();

  constructor(private options: ServiceOptions = {}) {
    this.cache = options.cache ?? new MemoryPdfCache();
  }

  async read(token: string, args: PdfReadOptions) {
    if (!token) throw new Error("Authentication required");
    // Always authorize before using cached content, even for an unchanged ID.
    const block = await (this.options.fetchBlock ?? fetchBlock)(
      token,
      args.block_id,
    );
    const attachment = block.attachment;
    if (
      !attachment ||
      !(
        attachment.content_type?.toLowerCase().split(";")[0] ===
          "application/pdf" ||
        attachment.file_extension?.toLowerCase() === "pdf" ||
        /\.pdf$/i.test(attachment.filename ?? "") ||
        /\.pdf$/i.test(new URL(attachment.url).pathname)
      )
    )
      throw new Error("Block does not contain a PDF attachment");
    validateAttachmentUrl(attachment.url);
    if ((attachment.file_size ?? 0) > MAX_PDF_BYTES)
      throw new Error("PDF exceeds the 25 MiB download limit");
    const key = `pdf:v1:${await hashKey(
      JSON.stringify([
        token,
        block.id,
        block.updated_at,
        attachment.updated_at,
        attachment.url,
      ]),
    )}`;
    let bytes: Uint8Array | undefined;
    const cached = args.refresh ? null : await this.cache.get(key);
    let doc: CachedDocument;
    if (cached) {
      doc = JSON.parse(cached) as CachedDocument;
    } else {
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          const data = await (this.options.download ?? downloadPdf)(
            attachment.url,
          );
          const pages = await (this.options.extract ?? extractPdf)(data);
          const result = {
            pages,
            extracted_at: new Date().toISOString(),
            revision: crypto.randomUUID(),
          };
          await this.cache.put(key, JSON.stringify(result));
          return { doc: result, bytes: data };
        })();
        this.inFlight.set(key, pending);
      }
      try {
        ({ doc, bytes } = await pending);
      } finally {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      }
    }

    const totalPages = doc.pages.length;
    const start = args.start_page ?? 1;
    const end = args.end_page ?? totalPages;
    const numbers = args.pages
      ? [...new Set(args.pages)].sort((a, b) => a - b)
      : Array.from(
          { length: Math.max(0, end - start + 1) },
          (_, i) => start + i,
        );
    if (
      !numbers.length ||
      numbers.some((n) => !Number.isInteger(n) || n < 1 || n > totalPages)
    ) {
      throw new Error(`Page numbers must be between 1 and ${totalPages}`);
    }
    if (args.pages && numbers.length > 50)
      throw new Error("Select at most 50 pages per call");
    // OCR only the pages that can fit in this response; resume using continuation.
    const maxChars = args.max_chars ?? 100_000;
    if (maxChars < 1 || maxChars > 250_000)
      throw new Error("max_chars must be between 1 and 250000");
    let budget = maxChars;
    const selected: ExtractedPage[] = [];
    for (const n of numbers) {
      if (budget <= 0) break;
      selected.push({ ...doc.pages[n - 1] });
      const offset = selected.length === 1 ? (args.start_char ?? 0) : 0;
      budget -= Math.max(1, doc.pages[n - 1].text.length - offset);
    }
    const ocrMode = args.ocr ?? "off";
    const language = args.language ?? "eng";
    const needsOcr = selected.filter(
      (page) =>
        ocrMode === "force" ||
        (ocrMode === "auto" && page.text.replace(/\s/g, "").length < 20),
    );
    const ocrPages = new Set<number>();
    if (needsOcr.length) {
      const provider = this.options.ocr;
      if (!provider)
        throw new Error(
          "OCR requested but no provider is configured; set PDF_OCR=local for stdio or PDF_OCR_ENDPOINT for HTTP",
        );
      if (needsOcr.length > 20)
        throw new Error(
          "OCR is limited to 20 pages per call; use get_pdf_pages with a smaller selection",
        );
      const ocrKey = `${key}:ocr:${await hashKey(`${provider.id}:${language}:${doc.revision}`)}`;
      const stored = args.refresh ? null : await this.cache.get(ocrKey);
      const recognized = stored
        ? (JSON.parse(stored) as Record<number, string>)
        : {};
      const missing = needsOcr.filter(
        (page) => recognized[page.page] === undefined,
      );
      if (missing.length) {
        bytes ??= await (this.options.download ?? downloadPdf)(attachment.url);
        const result = await provider.recognize(
          bytes,
          missing.map((p) => p.page),
          language,
        );
        for (const page of missing) {
          if (typeof result[page.page] !== "string")
            throw new Error(`OCR provider omitted page ${page.page}`);
          if (result[page.page].length > 250_000)
            throw new Error("OCR page exceeds the character limit");
          recognized[page.page] = result[page.page];
        }
        await this.cache.put(ocrKey, JSON.stringify(recognized));
      }
      for (const page of needsOcr) {
        page.text = recognized[page.page];
        ocrPages.add(page.page);
      }
    }

    let remaining = maxChars;
    let continuation: { page: number; start_char: number } | null = null;
    const output: Array<
      ExtractedPage & {
        start_char: number;
        end_char: number;
        truncated: boolean;
        extraction: string;
        needs_ocr: boolean;
        citation: string;
        pdf_url: string;
      }
    > = [];
    for (const page of selected) {
      const startChar = output.length === 0 ? (args.start_char ?? 0) : 0;
      if (startChar > page.text.length)
        throw new Error("start_char exceeds the first selected page length");
      const text = page.text.slice(startChar, startChar + remaining);
      remaining -= text.length;
      const truncated = startChar + text.length < page.text.length;
      output.push({
        ...page,
        text,
        start_char: startChar,
        end_char: startChar + text.length,
        truncated,
        extraction: ocrPages.has(page.page) ? "ocr" : "text",
        needs_ocr:
          !ocrPages.has(page.page) && page.text.replace(/\s/g, "").length < 20,
        citation: `[Are.na block ${block.id}, PDF page ${page.page}](https://www.are.na/block/${block.id})`,
        pdf_url: `${attachment.url.split("#")[0]}#page=${page.page}`,
      });
      if (truncated) {
        continuation = { page: page.page, start_char: startChar + text.length };
        break;
      }
      if (remaining <= 0) break;
    }
    const returned = output.map((p) => p.page);
    const omitted = numbers.filter((n) => !returned.includes(n));
    continuation ??= omitted.length
      ? { page: omitted[0], start_char: 0 }
      : null;
    return {
      block_id: block.id,
      title: block.title ?? attachment.filename ?? "PDF",
      block_url: `https://www.are.na/block/${block.id}`,
      source_url: attachment.url,
      total_pages: totalPages,
      page_numbering:
        "1-based physical PDF pages; label preserves printed page labels when present",
      extracted_at: doc.extracted_at,
      cache_hit: Boolean(cached),
      ocr: ocrMode,
      pages: output,
      omitted_pages: omitted,
      continuation,
    };
  }
}
