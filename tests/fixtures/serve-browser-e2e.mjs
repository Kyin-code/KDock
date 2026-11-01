import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const html = readFileSync(new URL("./browser-e2e.html", import.meta.url));
const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
});
server.listen(9450, "127.0.0.1");
