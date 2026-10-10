export const MAX_PDF_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_HOSTS = new Set([
  "attachments.are.na",
  "d2w9rnfcy7mm78.cloudfront.net",
  "arena-attachments.s3.amazonaws.com",
  "s3.amazonaws.com",
]);

/** Restrict downloads to Are.na storage, including every redirect hop. */
export function validateAttachmentUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !ATTACHMENT_HOSTS.has(url.hostname) ||
    (url.hostname === "s3.amazonaws.com" &&
      !url.pathname.startsWith("/arena-attachments/"))
  ) {
    throw new Error("PDF URL must use an approved Are.na attachment host");
  }
  return url;
}

export async function downloadPdf(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  let url = validateAttachmentUrl(input);
  const signal = AbortSignal.timeout(30_000);
  for (let hop = 0; hop <= 3; hop++) {
    // Attachment URLs are signed/public. Never send the Are.na API bearer
    // token to the CDN, an attachment URL, or a redirected destination.
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 3) throw new Error("Invalid PDF redirect");
      url = validateAttachmentUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`PDF download failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) {
      await response.body?.cancel();
      throw new Error("PDF exceeds the 25 MiB download limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("PDF download returned an empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PDF_BYTES) {
          await reader.cancel();
          throw new Error("PDF exceeds the 25 MiB download limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
      throw new Error("Attachment is not a PDF (missing PDF signature)");
    }
    return bytes;
  }
  throw new Error("Too many PDF redirects");
}
