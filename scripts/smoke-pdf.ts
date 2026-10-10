import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Verify a deployed/local HTTP server without printing credentials or document text.
const [url, blockId] = process.argv.slice(2);
const token = process.env["ARENA_ACCESS_TOKEN"];
if (!url || !/^\d+$/.test(blockId ?? "") || !token) {
  throw new Error(
    "Usage: ARENA_ACCESS_TOKEN=... yarn smoke:pdf <mcp-url> <block-id>",
  );
}
const client = new Client({ name: "arena-pdf-smoke", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
try {
  const { tools } = await client.listTools();
  for (const name of ["getBlock", "read_pdf_block", "get_pdf_pages"]) {
    if (!tools.some((tool) => tool.name === name))
      throw new Error(`Missing tool ${name}`);
  }
  console.log(JSON.stringify({ tools: tools.length }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.callTool({
      name: "get_pdf_pages",
      arguments: { block_id: Number(blockId), pages: [1] },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    const content = result.content as Array<{ type: string; text: string }>;
    const document = JSON.parse(content[0].text);
    console.log(
      JSON.stringify({
        attempt,
        total_pages: document.total_pages,
        cache_hit: document.cache_hit,
        pages: document.pages.map(
          (page: { page: number; text: string; extraction: string }) => ({
            page: page.page,
            chars: page.text.length,
            extraction: page.extraction,
          }),
        ),
      }),
    );
    if (attempt === 1 && !document.cache_hit)
      throw new Error("Second call did not reuse the cache");
  }
} finally {
  await client.close();
}
