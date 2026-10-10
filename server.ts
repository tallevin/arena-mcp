import { Hono } from "hono";
import { createVercelHandler } from "./src/transports/vercel";

// Vercel detects this root Hono entry and supplies the Node.js runtime.
const handle = createVercelHandler(process.env);
const app = new Hono();
app.all("*", (c) => handle(c.req.raw));
export default app;
