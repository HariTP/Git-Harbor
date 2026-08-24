import type { AuthSession, AuthStatus } from "../auth/auth-session.js";
import { GitStorageError } from "../domain/errors.js";
import type { GitStorageApplication, DoctorReport } from "../application/git-storage-application.js";

export interface CliRuntime {
  readonly auth: Pick<AuthSession, "login" | "status" | "logout">;
  readonly application: Pick<GitStorageApplication, "createRemote" | "doctor">;
}

export interface TextOutput {
  write(message: string): unknown;
}

export interface CliOptions {
  readonly runtime: CliRuntime;
  readonly version?: string;
  readonly stdout?: TextOutput;
  readonly stderr?: TextOutput;
}

export interface CliResult {
  readonly exitCode: 0 | 1 | 2;
}

/** Runs the human CLI without directly depending on process globals. */
export async function runCli(arguments_: readonly string[], options: CliOptions): Promise<CliResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const version = options.version ?? "0.0.0";

  try {
    if (isCommand(arguments_, ["version"])) {
      stdout.write(`${version}\n`);
      return { exitCode: 0 };
    }
    if (isCommand(arguments_, ["auth", "status"])) {
      writeAuthStatus(stdout, await options.runtime.auth.status());
      return { exitCode: 0 };
    }
    if (isCommand(arguments_, ["auth", "logout"])) {
      await options.runtime.auth.logout();
      stdout.write("Signed out locally.\n");
      return { exitCode: 0 };
    }
    if (arguments_[0] === "auth" && arguments_[1] === "login") {
      const credentialsPath = parseCredentialsPath(arguments_);
      writeAuthStatus(stdout, await options.runtime.auth.login(credentialsPath));
      stdout.write("Signed in locally.\n");
      return { exitCode: 0 };
    }
    if (arguments_[0] === "init") {
      const name = parseRepositoryName(arguments_);
      const remote = await options.runtime.application.createRemote(name);
      stdout.write(`Created Drive-backed Git remote: ${remote.metadata.displayName}\n`);
      stdout.write(`Remote URL: gdrive://${remote.remoteId}\n\n`);
      stdout.write("Add it to the current repository with:\n");
      stdout.write(`  git remote add origin gdrive://${remote.remoteId}\n`);
      return { exitCode: 0 };
    }
    if (isCommand(arguments_, ["doctor"])) {
      const report = await options.runtime.application.doctor();
      writeDoctorReport(stdout, report);
      return { exitCode: report.ok ? 0 : 1 };
    }

    throw usageError();
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return { exitCode: 2 };
    }
    stderr.write(`${formatError(error)}\n`);
    return { exitCode: 1 };
  }
}

function isCommand(arguments_: readonly string[], expected: readonly string[]): boolean {
  return arguments_.length === expected.length && expected.every((argument, index) => arguments_[index] === argument);
}

function parseCredentialsPath(arguments_: readonly string[]): string {
  if (arguments_.length !== 4 || arguments_[2] !== "--credentials" || !isNonEmptyArgument(arguments_[3])) {
    throw usageError();
  }
  return arguments_[3];
}

function parseRepositoryName(arguments_: readonly string[]): string {
  if (arguments_.length !== 3 || arguments_[1] !== "--name" || !isNonEmptyArgument(arguments_[2])) {
    throw usageError();
  }
  return arguments_[2];
}

function isNonEmptyArgument(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function writeAuthStatus(stdout: TextOutput, status: AuthStatus): void {
  stdout.write(`OAuth credentials: ${status.hasCredentials ? "available" : "missing"}\n`);
  stdout.write(`Refresh token: ${status.hasRefreshToken ? "available" : "missing"}\n`);
  stdout.write(`Authentication: ${status.isUsable ? "ready" : "sign in required"}\n`);
}

function writeDoctorReport(stdout: TextOutput, report: DoctorReport): void {
  for (const check of report.checks) {
    const level = check.required ? "required" : "optional";
    const outcome = check.ok ? "OK" : "FAIL";
    stdout.write(`[${level}] ${outcome} ${check.name}${check.message ? `: ${check.message}` : ""}\n`);
  }
  stdout.write(`Doctor: ${report.ok ? "passed" : "failed"}\n`);
}

function formatError(error: unknown): string {
  if (error instanceof GitStorageError) {
    return `Error [${error.code}]: ${error.message}`;
  }
  return "Error [INTERNAL_ERROR]: The command could not be completed.";
}

class UsageError extends Error {}

function usageError(): UsageError {
  return new UsageError(
    "Usage: git gdrive <auth login --credentials PATH|auth status|auth logout|init --name NAME|doctor|version>",
  );
}
