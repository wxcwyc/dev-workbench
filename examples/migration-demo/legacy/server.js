import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.argv[2] ?? 4173);
const pageUrl = new URL("./index.html", import.meta.url);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid port: ${process.argv[2]}`);
}

const server = createServer(async (request, response) => {
  const pathname = request.url?.split("?", 1)[0];

  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    console.log(`${request.method} ${pathname} 200`);
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    try {
      const page = await readFile(pageUrl);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      console.log(`${request.method} ${pathname} 200`);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("preview unavailable\n");
      console.error(error);
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
  console.log(`${request.method} ${pathname} 404`);
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Legacy preview listening on ${host}:${address.port}`);
});

let closing = false;
function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
