import { PROTOCOL_VERSION, assertAdapterManifest, assertTraceEvent } from "../../protocol/src/index.js";

export function defineAdapter(manifest, run) {
  assertAdapterManifest(manifest);
  if (typeof run !== "function") throw new TypeError("Adapter run must be a function");

  return Object.freeze({
    manifest: Object.freeze(structuredClone(manifest)),
    async *run(input) {
      const stream = await run(input);
      if (!stream?.[Symbol.asyncIterator] && !stream?.[Symbol.iterator]) {
        throw new TypeError("Adapter run must return an iterable of trace events");
      }
      for await (const traceEvent of stream) yield assertTraceEvent(traceEvent);
    }
  });
}

export function createTraceEvent({ sessionId, sequence, kind = "evaluation", title, explanation = "", state, artifacts = [] }) {
  return assertTraceEvent({ protocolVersion: PROTOCOL_VERSION, sessionId, sequence, kind, title, explanation, state, artifacts });
}

export async function* encodeNdjson(traceEvents) {
  for await (const traceEvent of traceEvents) yield `${JSON.stringify(assertTraceEvent(traceEvent))}\n`;
}

export async function* decodeNdjson(chunks, { maxLineLength = 1024 * 1024 } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let lineNumber = 0;

  const parseLine = (line) => {
    lineNumber += 1;
    if (!line.trim()) return null;
    try { return assertTraceEvent(JSON.parse(line)); }
    catch (error) {
      error.message = `Invalid NDJSON at line ${lineNumber}: ${error.message}`;
      throw error;
    }
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
      const traceEvent = parseLine(line);
      if (traceEvent) yield traceEvent;
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
  }

  buffer += decoder.decode();
  if (buffer) {
    if (buffer.length > maxLineLength) throw new Error(`NDJSON line ${lineNumber + 1} exceeds the size limit`);
    const traceEvent = parseLine(buffer.replace(/\r$/, ""));
    if (traceEvent) yield traceEvent;
  }
}
