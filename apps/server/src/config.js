import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const webRoot = path.join(projectRoot, "apps", "web");
export const stateRoot = path.join(projectRoot, ".dev-workbench", "sessions");
export const examplesRoot = path.join(projectRoot, "examples");
export const allowedRoot = path.resolve(process.env.DEV_WORKBENCH_ALLOWED_ROOT ?? os.homedir());
export const port = Number.parseInt(process.env.DEV_WORKBENCH_PORT ?? "4177", 10);
