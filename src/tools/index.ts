import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchAndConnect } from "./custom/search-and-connect.js";
import { registerChannelDigest } from "./custom/channel-digest.js";
import { registerPdfTools } from "./custom/pdf.js";
import type { PdfService } from "../pdf/service.js";

export function registerCustomTools(server: McpServer, pdf: PdfService): void {
  registerSearchAndConnect(server);
  registerChannelDigest(server);
  registerPdfTools(server, pdf);
}
