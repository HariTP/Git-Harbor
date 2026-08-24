import { spawn } from "node:child_process";
import { devNull } from "node:os";

import { GitStorageError } from "../domain/errors.js";

export interface GitProcessResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly allowFailure?: boolean;
}

/** Runs Git without inheriting user configuration or untrusted environment values. */
export class GitProcess {
  async run(args: readonly string[], options: GitProcessOptions): Promise<GitProcessResult> {
    if (args.length === 0) {
      throw new GitStorageError("GIT_COMMAND_FAILED", "Git command was not specified.");
    }

    let result: GitProcessResult;
    try {
      result = await runGit(args, options.cwd);
    } catch (error) {
      if (isMissingExecutable(error)) {
        throw new GitStorageError("GIT_NOT_FOUND", "Git is not installed or unavailable.", { cause: error });
      }
      throw error;
    }

    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new GitStorageError(
        "GIT_COMMAND_FAILED",
        `Git command failed: ${safeCommandName(args)}.`,
      );
    }

    return result;
  }
}

function runGit(args: readonly string[], cwd: string): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: devNull,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        command: safeCommandName(args),
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function safeCommandName(args: readonly string[]): string {
  return args[0]!.replace(/[^a-z-]/gi, "").slice(0, 64) || "git";
}

function isMissingExecutable(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
