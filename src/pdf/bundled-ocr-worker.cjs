const { parentPort, workerData } = require("node:worker_threads");
const { dirname } = require("node:path");
const { createWorker, OEM } = require("tesseract.js");
const { PNG } = require("pngjs");

// Tesseract chooses a CPU variant at runtime. Explicitly trace its WASM files,
// which are opened indirectly by the generated engine rather than JS imports.
require.resolve("tesseract.js-core/tesseract-core.wasm");
require.resolve("tesseract.js-core/tesseract-core-lstm.wasm");
require.resolve("tesseract.js-core/tesseract-core-simd.wasm");
require.resolve("tesseract.js-core/tesseract-core-simd-lstm.wasm");
require.resolve("tesseract.js-core/tesseract-core-relaxedsimd.wasm");
require.resolve("tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm");

async function recognize() {
  let library, document, engine;
  try {
    const { PDFiumLibrary } = await import("@hyzyla/pdfium/inline");
    library = await PDFiumLibrary.init({ disableBase64Warning: true });
    document = await library.loadDocument(workerData.bytes);
    if (workerData.pages.some((page) => page > document.getPageCount()))
      throw new Error("Requested OCR page is outside the document");

    // Static asset paths allow deployment tracing; never download language data.
    const languageFile =
      require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz");
    engine = await createWorker("eng", OEM.LSTM_ONLY, {
      langPath: dirname(languageFile),
      workerPath:
        require.resolve("tesseract.js/src/worker-script/node/index.js"),
      cacheMethod: "none",
      errorHandler: () => {},
    });
    const pages = {};
    for (const number of workerData.pages) {
      const page = document.getPage(number - 1);
      try {
        const { originalWidth: width, originalHeight: height } =
          page.getOriginalSize();
        if (![width, height].every((size) => Number.isFinite(size) && size > 0))
          throw new Error("Invalid PDF page dimensions");
        const scale = Math.min(150 / 72, 3000 / Math.max(width, height));
        const image = await page.render({ scale });
        if (image.width * image.height > 9_000_000)
          throw new Error("OCR image exceeds the pixel limit");
        const png = PNG.sync.write({
          width: image.width,
          height: image.height,
          data: Buffer.from(image.data),
        });
        const result = await engine.recognize(png);
        if (result.data.text.length > 250_000)
          throw new Error("OCR page exceeds the text limit");
        pages[number] = result.data.text;
      } finally {
        page.close();
      }
    }
    return pages;
  } finally {
    await engine?.terminate();
    document?.destroy();
    library?.destroy();
  }
}

recognize().then(
  (pages) => parentPort.postMessage({ ok: true, pages }),
  (error) =>
    parentPort.postMessage({
      ok: false,
      error: String(error?.message ?? error).slice(0, 300),
    }),
);
