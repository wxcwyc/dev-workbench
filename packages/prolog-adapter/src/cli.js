import fs from "node:fs/promises";
import { encodeNdjson } from "../../adapter-sdk/src/index.js";
import { prologAdapter } from "./index.js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const sourcePath = option("source");
const query = option("query");
const sessionId = option("session");
if (!sourcePath || !query || !sessionId) {
  console.error("Usage: node packages/prolog-adapter/src/cli.js --source program.pl --query \"goal(X).\" --session SESSION_ID");
  process.exitCode = 2;
} else {
  try {
    const source = await fs.readFile(sourcePath, "utf8");
    const events = prologAdapter.run({ sessionId, source, sourcePath, query });
    for await (const line of encodeNdjson(events)) process.stdout.write(line);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
