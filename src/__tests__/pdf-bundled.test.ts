import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFiumLibrary } from "@hyzyla/pdfium/inline";
import { PNG } from "pngjs";
import { BundledOcrProvider } from "../pdf/bundled-ocr.js";
import { PdfService } from "../pdf/service.js";
import { extractPdf } from "../pdf/extract.js";

async function scannedFixture() {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (const text of [
    "First scanned page 12345",
    "Second scanned evidence 67890",
  ])
    source
      .addPage([600, 400])
      .drawText(text, { x: 30, y: 300, size: 24, font });
  const scanned = await PDFDocument.create();
  const library = await PDFiumLibrary.init({ disableBase64Warning: true });
  const document = await library.loadDocument(await source.save());
  try {
    for (let index = 0; index < 2; index++) {
      const page = document.getPage(index);
      try {
        const rendered = await page.render({ scale: 150 / 72 });
        const png = new PNG({ width: rendered.width, height: rendered.height });
        png.data = Buffer.from(rendered.data);
        const image = await scanned.embedPng(PNG.sync.write(png));
        scanned
          .addPage([600, 400])
          .drawImage(image, { x: 0, y: 0, width: 600, height: 400 });
      } finally {
        page.close();
      }
    }
  } finally {
    document.destroy();
    library.destroy();
  }
  return scanned.save();
}

describe("bundled Node OCR", () => {
  it("reads only selected scanned pages, retains citations, defaults off and caches recognized text", async () => {
    const bytes = await scannedFixture();
    expect((await extractPdf(bytes)).map((page) => page.text)).toEqual([
      "",
      "",
    ]);
    const provider = new BundledOcrProvider();
    const recognize = vi.spyOn(provider, "recognize");
    const download = vi.fn(async () => bytes);
    const service = new PdfService({
      ocr: provider,
      download,
      fetchBlock: async () => ({
        id: 42,
        title: "Scan",
        attachment: {
          url: "https://attachments.are.na/42/scan.pdf",
          content_type: "application/pdf",
        },
      }),
    });
    const native = await service.read("alice", { block_id: 42, pages: [2] });
    expect(native.pages[0]).toMatchObject({
      text: "",
      extraction: "text",
      needs_ocr: true,
    });
    expect(recognize).not.toHaveBeenCalled();
    const result = await service.read("alice", {
      block_id: 42,
      pages: [2],
      ocr: "auto",
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      page: 2,
      extraction: "ocr",
      needs_ocr: false,
    });
    expect(result.pages[0].text).toContain("Second scanned evidence 67890");
    expect(result.pages[0].citation).toContain("PDF page 2");
    expect(result.pages[0].pdf_url).toMatch(/#page=2$/);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const cached = await service.read("alice", {
      block_id: 42,
      pages: [2],
      ocr: "auto",
    });
    expect(cached.pages[0].text).toBe(result.pages[0].text);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("terminates overdue work and leaves capacity for subsequent requests", async () => {
    const bytes = await scannedFixture();
    await expect(
      new BundledOcrProvider(1).recognize(bytes, [1], "eng"),
    ).rejects.toThrow("deadline");
    const result = await new BundledOcrProvider().recognize(bytes, [1], "eng");
    expect(result[1]).toContain("First scanned page 12345");
  }, 30_000);

  it("rejects unsupported languages, invalid selections, oversized input and out-of-range pages", async () => {
    const provider = new BundledOcrProvider();
    await expect(
      provider.recognize(new Uint8Array(), [1], "fra"),
    ).rejects.toThrow("supports language eng");
    for (const pages of [[], [0], [1.5], Array(21).fill(1)])
      await expect(
        provider.recognize(new Uint8Array(), pages, "eng"),
      ).rejects.toThrow("1–20");
    await expect(
      provider.recognize(new Uint8Array(25 * 1024 * 1024 + 1), [1], "eng"),
    ).rejects.toThrow("25 MiB");
    await expect(
      provider.recognize(await scannedFixture(), [3], "eng"),
    ).rejects.toThrow("outside the document");
  }, 30_000);

  it("limits simultaneous jobs and reports malformed documents", async () => {
    const provider = new BundledOcrProvider(2000);
    const jobs = [
      provider.recognize(new Uint8Array(), [1], "eng"),
      provider.recognize(new Uint8Array(), [1], "eng"),
    ];
    await expect(
      provider.recognize(new Uint8Array(), [1], "eng"),
    ).rejects.toThrow("busy");
    const results = await Promise.allSettled(jobs);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });
});
