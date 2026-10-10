import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { DiskPdfCache, LocalOcrProvider } from "../pdf/local.js";
import { extractPdf } from "../pdf/extract.js";
import { hashKey } from "../pdf/service.js";

const execute = promisify(execFile);
function hasProgram(program: string) {
  try {
    execFileSync(program, ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("persistent local cache", () => {
  it("survives new instances, protects files and expires content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arena-cache-test-"));
    try {
      const key = `pdf:v1:${await hashKey("test")}`;
      await new DiskPdfCache(directory).put(key, "extracted text");
      expect(await new DiskPdfCache(directory).get(key)).toBe("extracted text");
      const path = join(directory, key.replaceAll(":", "-") + ".json");
      if (process.platform !== "win32")
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      const old = new Date(Date.now() - 8 * 86400_000);
      await utimes(path, old, old);
      expect(await new DiskPdfCache(directory).get(key)).toBeNull();
      await expect(
        new DiskPdfCache(directory).get("../../secret"),
      ).rejects.toThrow("cache key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("local OCR", () => {
  const available = hasProgram("pdftoppm") && hasProgram("tesseract");
  it.skipIf(!available)(
    "recognizes an image-only scanned PDF using Poppler and Tesseract",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "arena-scan-test-"));
      try {
        const source = await PDFDocument.create();
        const font = await source.embedFont(StandardFonts.Helvetica);
        source.addPage([600, 400]).drawText("Scanned research evidence 12345", {
          x: 30,
          y: 300,
          size: 24,
          font,
        });
        const input = join(directory, "source.pdf");
        await writeFile(input, await source.save());
        await execute("pdftoppm", [
          "-png",
          "-r",
          "150",
          "-singlefile",
          input,
          join(directory, "scan"),
        ]);
        const scanned = await PDFDocument.create();
        const image = await scanned.embedPng(
          await readFile(join(directory, "scan.png")),
        );
        scanned
          .addPage([600, 400])
          .drawImage(image, { x: 0, y: 0, width: 600, height: 400 });
        const bytes = await scanned.save();
        expect((await extractPdf(bytes))[0].text).toBe("");
        const recognized = await new LocalOcrProvider().recognize(
          bytes,
          [1],
          "eng",
        );
        expect(recognized[1]).toContain("Scanned research evidence 12345");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("rejects unsafe languages and reports missing executables clearly", async () => {
    const provider = new LocalOcrProvider(
      "/nonexistent/poppler",
      "/nonexistent/tesseract",
    );
    await expect(
      provider.recognize(new Uint8Array(), [1], "eng;rm"),
    ).rejects.toThrow("language");
    await expect(
      provider.recognize(new Uint8Array(), [1], "eng"),
    ).rejects.toThrow("check pdftoppm");
  });
});
