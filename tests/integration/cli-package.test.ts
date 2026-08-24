import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, test } from "vitest";

import { runCli, type CliRuntime } from "../../src/cli/cli.js";
import { GitStorageError } from "../../src/domain/errors.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-storage-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git gdrive", () => {
  test("prints the supplied package version without creating an OAuth session", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCli(["version"], {
      version: "9.8.7",
      stdout: { write: (message: string) => stdout.push(message) },
      stderr: { write: (message: string) => stderr.push(message) },
      runtime: unavailableRuntime(),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout).toEqual(["9.8.7\n"]);
    expect(stderr).toEqual([]);
  });

  test("reports auth status and logs out without exposing token values", async () => {
    const stdout: string[] = [];
    const calls: string[] = [];
    const runtime = unavailableRuntime({
      auth: {
        ...unavailableRuntime().auth,
        status: async () => ({ hasCredentials: true, hasRefreshToken: true, isUsable: true }),
        logout: async () => { calls.push("logout"); },
      },
    });

    await expect(runCli(["auth", "status"], { runtime, stdout: writer(stdout) })).resolves.toEqual({ exitCode: 0 });
    await expect(runCli(["auth", "logout"], { runtime, stdout: writer(stdout) })).resolves.toEqual({ exitCode: 0 });

    expect(stdout.join("")).toContain("Authentication: ready");
    expect(stdout.join("")).not.toContain("secret-token");
    expect(stdout.join("")).toContain("Signed out locally.");
    expect(calls).toEqual(["logout"]);
  });

  test("passes the explicit credentials path to injected desktop authentication", async () => {
    const stdout: string[] = [];
    const credentialPaths: string[] = [];
    const runtime = unavailableRuntime({
      auth: {
        ...unavailableRuntime().auth,
        login: async (credentialsPath: string) => {
          credentialPaths.push(credentialsPath);
          return { hasCredentials: true, hasRefreshToken: true, isUsable: true };
        },
      },
    });

    const result = await runCli(["auth", "login", "--credentials", "/safe/client.json"], {
      runtime,
      stdout: writer(stdout),
    });

    expect(result.exitCode).toBe(0);
    expect(credentialPaths).toEqual(["/safe/client.json"]);
    expect(stdout.join("")).toContain("Signed in locally.");
  });

  test("uses a stable usage exit code and redacts unexpected implementation errors", async () => {
    const stderr: string[] = [];
    await expect(runCli(["init"], { runtime: unavailableRuntime(), stderr: writer(stderr) }))
      .resolves.toEqual({ exitCode: 2 });
    expect(stderr.join("")).toContain("Usage: git gdrive");

    stderr.splice(0);
    const runtime = unavailableRuntime({
      application: {
        createRemote: async () => { throw new Error("access_token=should-not-appear"); },
        doctor: async () => ({ ok: true, checks: [] }),
      },
    });
    await expect(runCli(["init", "--name", "backup"], { runtime, stderr: writer(stderr) }))
      .resolves.toEqual({ exitCode: 1 });
    expect(stderr.join("")).toBe("Error [INTERNAL_ERROR]: The command could not be completed.\n");
  });

  test("prints a stable domain error without adding unsafe context", async () => {
    const stderr: string[] = [];
    const runtime = unavailableRuntime({
      application: {
        createRemote: async () => { throw new GitStorageError("DRIVE_PERMISSION_DENIED", "Drive access was denied."); },
        doctor: async () => ({ ok: true, checks: [] }),
      },
    });

    await expect(runCli(["init", "--name", "backup"], { runtime, stderr: writer(stderr) }))
      .resolves.toEqual({ exitCode: 1 });
    expect(stderr.join("")).toBe("Error [DRIVE_PERMISSION_DENIED]: Drive access was denied.\n");
  });

  test("prints a canonical remote URL after initialization", async () => {
    const stdout: string[] = [];
    const application = {
      createRemote: async (name: string) => ({ remoteId: "drive-folder-id", metadata: { displayName: name } }),
      doctor: async () => ({ ok: true, checks: [] }),
    };

    const result = await runCli(["init", "--name", "backup"], {
      runtime: unavailableRuntime({ application }),
      stdout: writer(stdout),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toContain("Created Drive-backed Git remote: backup");
    expect(stdout.join("")).toContain("Remote URL: gdrive://drive-folder-id");
  });

  test("does not fail doctor for an optional failure, but fails a required check", async () => {
    const stdout: string[] = [];
    const optionalOnly = unavailableRuntime({
      application: {
        createRemote: async () => ({ remoteId: "unused", metadata: {} }),
        doctor: async () => ({
          ok: true,
          checks: [{ name: "optional advisory", required: false, ok: false, message: "check failed" }],
        }),
      },
    });
    await expect(runCli(["doctor"], { runtime: optionalOnly, stdout: writer(stdout) }))
      .resolves.toEqual({ exitCode: 0 });
    expect(stdout.join("")).toContain("[optional] FAIL optional advisory");

    stdout.splice(0);
    const runtime = unavailableRuntime({
      application: {
        createRemote: async () => ({ remoteId: "unused", metadata: {} }),
        doctor: async () => ({
          ok: false,
          checks: [
            { name: "optional advisory", required: false, ok: false, message: "check failed" },
            { name: "Git executable", required: true, ok: false, message: "check failed" },
          ],
        }),
      },
    });

    const result = await runCli(["doctor"], { runtime, stdout: writer(stdout) });

    expect(result.exitCode).toBe(1);
    expect(stdout.join("")).toContain("[optional] FAIL optional advisory");
    expect(stdout.join("")).toContain("[required] FAIL Git executable");
  });
});

describe("packed executable", () => {
  test("installs both Git executables and keeps development files out of the tarball", async () => {
    const directory = await temporaryDirectory();
    const prefix = join(directory, "prefix");
    const packageDirectory = join(directory, "package");
    await mkdir(packageDirectory, { recursive: true });
    await run("npm", ["run", "build"]);
    await run("npm", ["pack", "--pack-destination", packageDirectory], {
      npm_config_cache: join(directory, "npm-pack-cache"),
    });
    const [tarball] = await readDirectory(packageDirectory);
    await run(
      "npm",
      ["install", "--global", "--no-audit", "--no-fund", "--prefix", prefix, join(packageDirectory, tarball)],
    );

    const installedPath = `${join(prefix, "bin")}:${process.env.PATH ?? ""}`;
    const version = await run("git", ["gdrive", "version"], { PATH: installedPath });
    expect(version.stdout.trim()).toBe("0.1.0");
    const discoveredExecutables = await run(
      "sh",
      ["-c", "command -v git-gdrive && command -v git-remote-gdrive"],
      { PATH: installedPath },
    );
    expect(discoveredExecutables.stdout).toContain(join(prefix, "bin", "git-gdrive"));
    expect(discoveredExecutables.stdout).toContain(join(prefix, "bin", "git-remote-gdrive"));

    const packedHome = join(directory, "packed-home");
    const packedGitConfig = join(directory, "packed.gitconfig");
    const packedEnvironment: NodeJS.ProcessEnv = {
      PATH: installedPath,
      HOME: packedHome,
      GIT_CONFIG_GLOBAL: packedGitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_GDRIVE_CONFIG_DIR: join(directory, "packed-config"),
      GIT_GDRIVE_FILESYSTEM_STORE_DIR: join(directory, "packed-store"),
    };
    await mkdir(packedHome, { recursive: true });
    await writeFile(packedGitConfig, "", { mode: 0o600 });
    const initialized = await run(
      "git",
      ["gdrive", "init", "--name", "packed-helper-smoke"],
      packedEnvironment,
    );
    const remoteUrl = /^Remote URL: (gdrive:\/\/[A-Za-z0-9_-]+)$/m.exec(initialized.stdout)?.[1];
    expect(remoteUrl).toMatch(/^gdrive:\/\/[A-Za-z0-9_-]+$/);

    const source = join(directory, "packed-source");
    const clone = join(directory, "packed-clone");
    await run("git", ["init", "--initial-branch=main", source], packedEnvironment);
    await run("git", ["-C", source, "config", "user.name", "Packed CLI Test"], packedEnvironment);
    await run(
      "git",
      ["-C", source, "config", "user.email", "packed-cli@example.invalid"],
      packedEnvironment,
    );
    await writeFile(join(source, "message.txt"), "packed helper round trip\n");
    await run("git", ["-C", source, "add", "--", "message.txt"], packedEnvironment);
    await run("git", ["-C", source, "commit", "-m", "packed helper commit"], packedEnvironment);
    const sourceHead = (await run("git", ["-C", source, "rev-parse", "HEAD"], packedEnvironment)).stdout.trim();
    await run("git", ["-C", source, "remote", "add", "origin", remoteUrl!], packedEnvironment);
    await run("git", ["-C", source, "push", "-u", "origin", "main"], packedEnvironment);
    await run("git", ["clone", remoteUrl!, clone], packedEnvironment);

    expect((await run("git", ["-C", clone, "rev-parse", "HEAD"], packedEnvironment)).stdout.trim())
      .toBe(sourceHead);
    expect((await run("git", ["-C", clone, "rev-parse", "refs/remotes/origin/main"], packedEnvironment)).stdout.trim())
      .toBe(sourceHead);
    expect(await readFile(join(clone, "message.txt"), "utf8")).toBe("packed helper round trip\n");
    expect((await run("git", ["-C", clone, "fsck", "--full"], packedEnvironment)).stdout).toBe("");

    const configDirectory = join(directory, "config-missing");
    const missing = await run("git", ["gdrive", "doctor"], {
      PATH: installedPath,
      GIT_GDRIVE_CONFIG_DIR: configDirectory,
      GIT_GDRIVE_FILESYSTEM_STORE_DIR: join(directory, "store"),
    }, false);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("OAuth credentials");

    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "oauth-client.json"), JSON.stringify({
      installed: { client_id: "test-client", client_secret: "not-a-real-secret", redirect_uris: ["http://localhost"] },
    }), { mode: 0o600 });
    const present = await run("git", ["gdrive", "doctor"], {
      PATH: installedPath,
      GIT_GDRIVE_CONFIG_DIR: configDirectory,
      GIT_GDRIVE_FILESYSTEM_STORE_DIR: join(directory, "store"),
    }, false);
    expect(present.stdout).toContain("OAuth credentials");
    expect(present.stdout).toContain("[required] OK OAuth credentials");

    const packageContents = await run("tar", ["-tzf", join(packageDirectory, tarball)]);
    expect(packageContents.stdout).toContain("package/dist/bin/git-gdrive.js");
    expect(packageContents.stdout).toContain("package/dist/bin/git-remote-gdrive.js");
    expect(packageContents.stdout).not.toMatch(/(^|\/)(\.secrets|\.env|coverage|tests)(\/|$)/);
    expect(packageContents.stdout).not.toContain("/tmp/");
    expect(packageContents.stdout).not.toContain("/home/");
  }, 180_000);
});

function writer(messages: string[]): { write(message: string): void } {
  return { write: (message) => messages.push(message) };
}

function unavailableRuntime(overrides: Record<string, unknown> = {}): CliRuntime {
  return {
    auth: {
      login: async () => ({ hasCredentials: false, hasRefreshToken: false, isUsable: false }),
      status: async () => ({ hasCredentials: false, hasRefreshToken: false, isUsable: false }),
      logout: async () => undefined,
      getAuthorizedClient: async () => { throw new Error("not used"); },
      getInstallationId: async () => "00000000-0000-4000-8000-000000000000",
    },
    application: {
      createRemote: async () => ({ remoteId: "unused", metadata: {} }),
      doctor: async () => ({ ok: true, checks: [] }),
    },
    ...overrides,
  } as unknown as CliRuntime;
}

async function readDirectory(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}

async function run(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  requireSuccess = true,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (requireSuccess && result.code !== 0) {
        reject(new Error(`${command} failed: ${stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}
