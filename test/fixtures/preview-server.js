import http from "node:http";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "normal";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("usage: preview-server.js <port> [mode]\n");
  process.exit(2);
}

if (mode === "early-exit") {
  process.stdout.write("preview fixture exiting early\n");
  process.stderr.write("preview fixture early-exit diagnostic\n");
  process.exit(17);
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(mode === "unhealthy" ? 503 : 204);
    response.end();
    return;
  }
  if (request.url === "/preview" || request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("preview fixture\n");
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`preview fixture listening on 127.0.0.1:${port}\n`);
  process.stderr.write("preview fixture diagnostic\n");
});

server.on("error", (error) => {
  process.stderr.write(`preview fixture error: ${error.message}\n`);
  process.exit(1);
});

process.on("SIGTERM", () => {
  if (mode === "ignore-term") {
    process.stderr.write("preview fixture ignoring SIGTERM\n");
    return;
  }
  server.close(() => process.exit(0));
});
