import { Worker } from "node:worker_threads";
import type { OcrProvider } from "./service.js";
import { MAX_PDF_BYTES } from "./download.js";

let activeJobs = 0;
const MAX_ACTIVE_JOBS = 2;

/** Node-only, opt-in OCR. Worker termination supplies a hard CPU deadline. */
export class BundledOcrProvider implements OcrProvider {
  readonly id = "bundled:pdfium3:tesseract7:eng1:150dpi:3000px:v1";

  constructor(private readonly timeoutMs = 180_000) {}

  async recognize(
    bytes: Uint8Array,
    pages: number[],
    language: string,
  ): Promise<Record<number, string>> {
    if (language !== "eng")
      throw new Error(
        "Bundled OCR supports language eng; configure PDF_OCR_ENDPOINT for other languages",
      );
    if (
      pages.length < 1 ||
      pages.length > 20 ||
      pages.some((page) => !Number.isSafeInteger(page) || page < 1)
    )
      throw new Error(
        "Bundled OCR requires 1–20 positive physical page numbers",
      );
    if (bytes.byteLength > MAX_PDF_BYTES)
      throw new Error("PDF exceeds the 25 MiB OCR limit");
    if (activeJobs >= MAX_ACTIVE_JOBS)
      throw new Error("OCR is busy; retry this page request shortly");

    activeJobs++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Transfer a copy so rendering cannot detach the service's original PDF.
      const input = bytes.slice();
      worker = new Worker(
        new URL("./bundled-ocr-worker.cjs", import.meta.url),
        {
          workerData: { bytes: input, pages: [...new Set(pages)] },
          transferList: [input.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        },
      );
      return await new Promise<Record<number, string>>((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Bundled OCR exceeded its 180-second deadline; request fewer pages",
              ),
            ),
          this.timeoutMs,
        );
        worker!.once("message", (message) => {
          if (message?.ok) resolve(message.pages);
          else
            reject(
              new Error(
                `Bundled OCR failed: ${message?.error ?? "worker error"}`,
              ),
            );
        });
        worker!.once("error", () =>
          reject(new Error("Bundled OCR worker failed")),
        );
        worker!.once("exit", () =>
          reject(new Error("Bundled OCR worker exited without a result")),
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      await worker?.terminate();
      activeJobs--;
    }
  }
}
