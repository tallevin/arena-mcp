import { getDocumentProxy } from "unpdf";

export interface ExtractedPage {
  page: number;
  label: string | null;
  text: string;
}

export const MAX_PDF_PAGES = 500;
export const MAX_EXTRACTED_CHARS = 5_000_000;

/** Sequential extraction bounds page fan-out and preserves PDF page labels. */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const pdf = await getDocumentProxy(bytes.slice(), {
    maxImageSize: 16_777_216,
    stopAtErrors: true,
  });
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF exceeds the ${MAX_PDF_PAGES} page limit`);
    }
    const labels = await pdf.getPageLabels();
    const pages: ExtractedPage[] = [];
    let chars = 0;
    const deadline = Date.now() + 30_000;
    for (let number = 1; number <= pdf.numPages; number++) {
      if (Date.now() > deadline)
        throw new Error("PDF extraction time limit exceeded");
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
      }
      text = text.replace(/ +\n/g, "\n").trim();
      chars += text.length;
      if (chars > MAX_EXTRACTED_CHARS) {
        throw new Error("PDF exceeds the 5 million extracted character limit");
      }
      pages.push({ page: number, label: labels?.[number - 1] ?? null, text });
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
