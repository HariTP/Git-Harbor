#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { createGitStorageRuntime } from "../application/runtime.js";
import { runCli } from "../cli/cli.js";

const version = await packageVersion();
const result = await runCli(process.argv.slice(2), {
  runtime: createGitStorageRuntime(),
  version,
});
process.exitCode = result.exitCode;

async function packageVersion(): Promise<string> {
  try {
    const document = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as unknown;
    if (typeof document === "object" && document !== null &&
      "version" in document && typeof document.version === "string" && document.version.length > 0) {
      return document.version;
    }
  } catch {
    // A malformed installation remains usable; the CLI reports a neutral version.
  }
  return "0.0.0";
}
