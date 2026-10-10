import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchAndConnect } from "./custom/search-and-connect";
import { registerChannelDigest } from "./custom/channel-digest";
import { registerPdfTools } from "./custom/pdf";
import type { PdfService } from "../pdf/service";

export function registerCustomTools(server: McpServer, pdf: PdfService): void {
  registerSearchAndConnect(server);
  registerChannelDigest(server);
  registerPdfTools(server, pdf);
}
