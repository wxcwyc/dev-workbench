const sources = /^(?:preview:(?:source|target)|step:\d+)$/;
const streams = new Set(["stdout", "stderr"]);

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
}

function truncateUtf8Suffix(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let suffix = "";
  let bytes = 0;
  const characters = Array.from(text);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    suffix = character + suffix;
    bytes += characterBytes;
  }
  return suffix;
}

export class TerminalBuffer {
  constructor({
    maxBytes = 256 * 1024,
    now = () => new Date().toISOString(),
  } = {}) {
    this.maxBytes = maxBytes;
    this.now = now;
    this.sessions = new Map();
  }

  append(sessionId, { source, stream, text }) {
    validateSessionId(sessionId);
    if (typeof source !== "string" || !sources.test(source)) {
      throw new TypeError("source must identify a preview or step");
    }
    if (!streams.has(stream)) {
      throw new TypeError("stream must be stdout or stderr");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new TypeError("text must be a non-empty string");
    }

    const state = this.#state(sessionId);
    const retainedText = truncateUtf8Suffix(text, this.maxBytes);
    const event = Object.freeze({
      type: "terminal.output",
      sequence: state.latestSequence + 1,
      source,
      stream,
      text: retainedText,
      at: this.now(),
    });
    state.latestSequence = event.sequence;
    state.events.push(event);
    state.bytes += Buffer.byteLength(retainedText, "utf8");

    while (state.events.length > 1 && state.bytes > this.maxBytes) {
      const removed = state.events.shift();
      state.bytes -= Buffer.byteLength(removed.text, "utf8");
    }

    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // One subscriber must not prevent delivery to the others.
      }
    }
    return event;
  }

  snapshot(sessionId) {
    validateSessionId(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) return { events: [], latestSequence: 0 };
    return {
      events: state.events.map((event) => ({ ...event })),
      latestSequence: state.latestSequence,
    };
  }

  subscribe(sessionId, listener) {
    validateSessionId(sessionId);
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    const state = this.#state(sessionId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  delete(sessionId) {
    validateSessionId(sessionId);
    this.sessions.delete(sessionId);
  }

  #state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        latestSequence: 0,
        bytes: 0,
        events: [],
        listeners: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}
