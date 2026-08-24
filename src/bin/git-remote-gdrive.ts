#!/usr/bin/env node

import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createGitStorageRuntime } from "../application/runtime.js";
import { GitStorageError } from "../domain/errors.js";
import { parseRemoteUrl } from "../domain/remote-url.js";
import { hasRemoteHelperDiagnostic, RemoteHelperSession } from "../remote-helper/remote-helper-session.js";

const execute = promisify(execFile);

async function main(): Promise<void> {
  const [remoteName, remoteUrl, ...extra] = process.argv.slice(2);
  if (!remoteName || !remoteUrl || extra.length > 0) {
    throw new GitStorageError("REMOTE_URL_INVALID", "Git did not provide a valid Drive remote URL.");
  }

  const remote = parseRemoteUrl(remoteUrl);
  const gitDirectory = await resolveGitDirectory();
  const runtime = createGitStorageRuntime();
  await new RemoteHelperSession({
    application: runtime.application,
    remoteId: remote.folderId,
    resourceKey: remote.resourceKey ?? undefined,
    gitDirectory,
  }).run(process.stdin, process.stdout);
}

async function resolveGitDirectory(): Promise<string> {
  try {
    const { stdout } = await execute("git", ["rev-parse", "--git-dir"], {
      cwd: process.cwd(),
      env: gitContextEnvironment(),
      encoding: "utf8",
    });
    const gitDirectory = stdout.trim();
    if (!gitDirectory || /[\r\n\0]/.test(gitDirectory)) {
      throw new Error("Git directory could not be resolved.");
    }
    return resolve(process.cwd(), gitDirectory);
  } catch (error) {
    throw new GitStorageError("GIT_COMMAND_FAILED", "Git repository context could not be resolved.", {
      cause: error,
    });
  }
}

function gitContextEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    HOME: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

try {
  await main();
} catch (error) {
  if (hasRemoteHelperDiagnostic(error)) {
    // The session already sent the concise diagnostic to stderr before terminating.
  } else if (error instanceof GitStorageError) {
    console.error(`git-remote-gdrive [${error.code}]: ${error.message}`);
  } else {
    console.error("git-remote-gdrive [INTERNAL_ERROR]: Remote helper failed.");
  }
  process.exitCode = 1;
}
