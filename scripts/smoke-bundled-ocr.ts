import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { BundledOcrProvider } from "../src/pdf/bundled-ocr.js";

// Run the compiled worker and packaged language assets, not the TS test loader.
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([600, 400]).drawText("Compiled OCR evidence 12345", {
  x: 30,
  y: 300,
  size: 24,
  font,
});
const result = await new BundledOcrProvider().recognize(
  await pdf.save(),
  [1],
  "eng",
);
assert.match(result[1], /Compiled OCR evidence 12345/);
console.log("Compiled bundled OCR and English language assets passed");
