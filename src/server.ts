import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGeneratedTools } from "./generated/tools.js";
import { registerCustomTools } from "./tools/index.js";
import { PdfService } from "./pdf/service.js";

const defaultPdfService = new PdfService();

export function createMcpServer(
  pdf: PdfService = defaultPdfService,
): McpServer {
  const server = new McpServer({
    name: "@aredotna/mcp",
    version: "0.1.0",
  });

  registerGeneratedTools(server);
  registerCustomTools(server, pdf);

  return server;
}
