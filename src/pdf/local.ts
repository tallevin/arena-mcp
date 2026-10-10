import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CACHE_TTL_SECONDS, type PdfCache } from "./cache";
import type { OcrProvider } from "./service";

const execute = promisify(execFile);

/** Atomic disk writes survive stdio restarts. Access is still checked per call. */
export class DiskPdfCache implements PdfCache {
  constructor(private directory: string) {}

  private path(key: string) {
    if (!/^pdf:v1:[a-f0-9]{64}(:ocr:[a-f0-9]{64})?$/.test(key)) {
      throw new Error("Invalid PDF cache key");
    }
    return join(this.directory, key.replaceAll(":", "-") + ".json");
  }

  async get(key: string) {
    const path = this.path(key);
    try {
      if ((await stat(path)).mtimeMs + CACHE_TTL_SECONDS * 1000 <= Date.now()) {
        await rm(path, { force: true });
        return null;
      }
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(key: string, value: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Prune expired entries during writes to bound long-lived local storage.
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(this.directory)) {
      if (!/^pdf-v1-[a-f0-9-]+(?:ocr-)?[a-f0-9]*\.json$/.test(file)) continue;
      const path = join(this.directory, file);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs + CACHE_TTL_SECONDS * 1000 <= Date.now()) {
        await rm(path, { force: true });
      }
    }
    const path = this.path(key);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** Optional local OCR: no shell interpolation and no document leaves the host. */
export class LocalOcrProvider implements OcrProvider {
  readonly id = "poppler-tesseract-150dpi-v1";

  constructor(
    private poppler = "pdftoppm",
    private tesseract = "tesseract",
  ) {}

  async recognize(bytes: Uint8Array, pages: number[], language: string) {
    if (!/^[a-zA-Z0-9_+]{1,64}$/.test(language))
      throw new Error("Invalid OCR language");
    if (
      pages.length > 20 ||
      pages.some((page) => !Number.isInteger(page) || page < 1)
    ) {
      throw new Error("OCR requires 1-based page numbers, at most 20 per call");
    }
    const directory = await mkdtemp(join(tmpdir(), "arena-pdf-ocr-"));
    const result: Record<number, string> = {};
    try {
      const input = join(directory, "document.pdf");
      await writeFile(input, bytes, { mode: 0o600 });
      for (const page of pages) {
        const image = join(directory, `page-${page}`);
        try {
          await execute(
            this.poppler,
            [
              "-f",
              String(page),
              "-l",
              String(page),
              "-scale-to",
              "3000",
              "-r",
              "150",
              "-png",
              "-singlefile",
              input,
              image,
            ],
            { timeout: 30_000, maxBuffer: 1024 * 1024 },
          );
          const { stdout } = await execute(
            this.tesseract,
            [`${image}.png`, "stdout", "-l", language],
            { timeout: 30_000, maxBuffer: 1024 * 1024 },
          );
          result[page] = stdout.trim();
        } catch {
          throw new Error(
            `Local OCR failed on page ${page}; check pdftoppm, tesseract and language data`,
          );
        }
        await rm(`${image}.png`, { force: true });
      }
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
