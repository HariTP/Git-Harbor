import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { RemoteHelperSession } from "../../src/remote-helper/remote-helper-session.js";
import { createGitStorageRuntime } from "../../src/application/runtime.js";
import type { AuthSession } from "../../src/auth/auth-session.js";
import { GitStorageError } from "../../src/domain/errors.js";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directories: string[] = [];
let sharedBuildRoot: string | undefined;
let sharedBuildDirectory: string | undefined;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeAll(async () => {
  sharedBuildRoot = await mkdtemp(join(tmpdir(), "git-storage-helper-fetch-build-"));
  await symlink(join(repositoryRoot, "node_modules"), join(sharedBuildRoot, "node_modules"));
  sharedBuildDirectory = join(sharedBuildRoot, "dist");
  await run(
    join(repositoryRoot, "node_modules/.bin/tsc"),
    ["-p", join(repositoryRoot, "tsconfig.json"), "--outDir", sharedBuildDirectory],
    sharedBuildRoot,
    process.env,
  );
  await chmod(join(sharedBuildDirectory, "bin/git-remote-gdrive.js"), 0o755);
}, 30_000);

afterAll(async () => {
  if (sharedBuildRoot !== undefined) {
    await rm(sharedBuildRoot, { recursive: true, force: true });
  }
});

describe("git-remote-gdrive fetch protocol", () => {
  test("responds to an interactive capability and list exchange without waiting for EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { stdout += chunk; });
    const session = new RemoteHelperSession({
      remoteId: "remote",
      gitDirectory: "/tmp/repository.git",
      stderr: diagnostics,
      application: {
        listRemote: async () => ({
          defaultBranch: "refs/heads/main",
          refs: [{ name: "refs/heads/main", objectId: "a".repeat(40) as never }],
        }),
        fetch: async () => undefined,
        push: async () => [],
      },
    });
    const running = session.run(input, output);

    input.write("capabilities\n");
    await waitFor(() => stdout === "fetch\npush\noption\n\n");
    input.write("list\n");
    await waitFor(() => stdout.endsWith(`${"a".repeat(40)} refs/heads/main\n@refs/heads/main HEAD\n\n`));
    input.write("option progress true\n");
    await waitFor(() => stdout.endsWith("unsupported\n"));
    input.end();
    await running;

    expect(diagnostics.read()?.toString() ?? "").toBe("");
  });

  test("keeps fatal diagnostics off protocol stdout and terminates the helper exchange", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8");
    diagnostics.setEncoding("utf8");
    output.on("data", (chunk: string) => { stdout += chunk; });
    diagnostics.on("data", (chunk: string) => { stderr += chunk; });
    const session = new RemoteHelperSession({
      remoteId: "missing",
      gitDirectory: "/tmp/repository.git",
      stderr: diagnostics,
      application: {
        listRemote: async () => { throw new GitStorageError("REMOTE_NOT_FOUND", "The repository remote was not found."); },
        fetch: async () => undefined,
        push: async () => [],
      },
    });

    const running = session.run(input, output);
    input.end("list\n");

    await expect(running).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
    expect(stdout).toBe("\n");
    expect(stderr).toBe("git-remote-gdrive [REMOTE_NOT_FOUND]: The repository remote was not found.\n");
  });

  test("propagates a resource key through list, fetch, and push without protocol output contamination", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { stdout += chunk; });
    const calls: unknown[] = [];
    const session = new RemoteHelperSession({
      remoteId: "shared-folder",
      resourceKey: "routing-key",
      gitDirectory: "/tmp/repository.git",
      application: {
        listRemote: async (remoteId, resourceKey) => {
          calls.push(["list", remoteId, resourceKey]);
          return {
            defaultBranch: "refs/heads/main",
            refs: [{ name: "refs/heads/main", objectId: "a".repeat(40) as never }],
          };
        },
        fetch: async (request) => { calls.push(["fetch", request]); },
        push: async (request) => {
          calls.push(["push", request]);
          return [{ destination: "refs/heads/main", ok: true }];
        },
      },
    });

    const running = session.run(input, output);
    input.end(
      `list\nfetch ${"a".repeat(40)} refs/heads/main\n\npush main:refs/heads/main\n\n`,
    );
    await running;

    expect(calls).toEqual([
      ["list", "shared-folder", "routing-key"],
      ["fetch", { remoteId: "shared-folder", resourceKey: "routing-key", targetGitDir: "/tmp/repository.git" }],
      ["push", {
        remoteId: "shared-folder",
        resourceKey: "routing-key",
        localGitDir: "/tmp/repository.git",
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      }],
    ]);
    expect(stdout).toBe(
      `${"a".repeat(40)} refs/heads/main\n@refs/heads/main HEAD\n\n\n` +
      "ok refs/heads/main\n\n",
    );
  });

  test("real Git clones, fetches a branch and tag, and imports a valid object graph", async () => {
    const fixture = await createFixture();
    const remote = await initializeRemote(fixture, "fetch-remote");
    const keyedRemote = `${remote}?resourcekey=routing-key`;
    const source = join(fixture.root, "source");
    await initRepository(fixture, source);
    await commit(fixture, source, "readme.txt", "first\n", "first");
    await git(fixture, source, ["tag", "v1.0.0"]);
    await git(fixture, source, ["remote", "add", "origin", keyedRemote]);

    await git(fixture, source, ["push", "-u", "origin", "main"]);
    await git(fixture, source, ["push", "origin", "v1.0.0"]);

    const clone = join(fixture.root, "clone");
    await git(fixture, fixture.root, ["clone", keyedRemote, clone]);
    expect(await git(fixture, clone, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await git(fixture, clone, ["show-ref", "--verify", "refs/tags/v1.0.0"])).not.toBe("");

    await git(fixture, source, ["switch", "-c", "feature"]);
    const feature = await commit(fixture, source, "feature.txt", "feature\n", "feature");
    await git(fixture, source, ["push", "-u", "origin", "feature"]);
    await git(fixture, clone, ["fetch", "origin"]);

    expect(await git(fixture, clone, ["rev-parse", "refs/remotes/origin/feature"])).toBe(feature);
    await expect(git(fixture, clone, ["fsck", "--full"])).resolves.toBe("");
  }, 30_000);

  test("a first push to trunk makes a fresh clone check out trunk as remote HEAD", async () => {
    const fixture = await createFixture();
    const remote = await initializeRemote(fixture, "trunk-remote");
    const source = join(fixture.root, "trunk-source");
    await initRepository(fixture, source);
    const trunk = await commit(fixture, source, "readme.txt", "trunk\n", "trunk commit");
    await git(fixture, source, ["branch", "-M", "trunk"]);
    await git(fixture, source, ["remote", "add", "origin", remote]);
    await git(fixture, source, ["push", "-u", "origin", "trunk"]);

    const clone = join(fixture.root, "trunk-clone");
    await git(fixture, fixture.root, ["clone", remote, clone]);

    expect(await git(fixture, clone, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("trunk");
    expect(await git(fixture, clone, ["rev-parse", "HEAD"])).toBe(trunk);
    expect(await git(fixture, clone, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe(
      "refs/remotes/origin/trunk",
    );
  }, 30_000);

  test("git pull --rebase preserves independent local and remote commits", async () => {
    const fixture = await createFixture();
    const remote = await initializeRemote(fixture, "rebase-remote");
    const repositoryA = join(fixture.root, "repository-a");
    await initRepository(fixture, repositoryA);
    await commit(fixture, repositoryA, "base.txt", "base\n", "base commit");
    await git(fixture, repositoryA, ["remote", "add", "origin", remote]);
    await git(fixture, repositoryA, ["push", "-u", "origin", "main"]);

    const repositoryB = join(fixture.root, "repository-b");
    await git(fixture, fixture.root, ["clone", remote, repositoryB]);
    await git(fixture, repositoryB, ["config", "user.name", "Git Storage Test B"]);
    await git(fixture, repositoryB, ["config", "user.email", "git-storage-b@example.invalid"]);
    const localCommitBeforeRebase = await commit(
      fixture,
      repositoryB,
      "local.txt",
      "local change\n",
      "local-only commit",
    );

    const remoteHead = await commit(
      fixture,
      repositoryA,
      "remote.txt",
      "remote change\n",
      "independent remote commit",
    );
    await git(fixture, repositoryA, ["push", "origin", "main"]);

    await git(fixture, repositoryB, ["pull", "--rebase", "origin", "main"]);

    const rebasedLocalCommit = await git(fixture, repositoryB, ["rev-parse", "HEAD"]);
    expect(rebasedLocalCommit).not.toBe(localCommitBeforeRebase);
    expect(await git(fixture, repositoryB, ["rev-parse", "HEAD^"])).toBe(remoteHead);
    expect(await git(fixture, repositoryB, ["rev-parse", "refs/remotes/origin/main"])).toBe(remoteHead);
    expect(await readFile(join(repositoryB, "base.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(repositoryB, "remote.txt"), "utf8")).toBe("remote change\n");
    expect(await readFile(join(repositoryB, "local.txt"), "utf8")).toBe("local change\n");
    await expect(git(fixture, repositoryB, ["merge-base", "--is-ancestor", remoteHead, "HEAD"])).resolves.toBe("");
    await expect(git(fixture, repositoryB, ["fsck", "--full"])).resolves.toBe("");
  }, 30_000);

  test("reports a stable, useful failure when the remote cannot be read", async () => {
    const fixture = await createFixture();
    const repository = join(fixture.root, "empty-repository");
    await initRepository(fixture, repository);
    await expect(runGitCapturingStderr(fixture, repository, ["ls-remote", "gdrive://missing-remote"])).rejects.toMatchObject({
      stderr: "git-remote-gdrive [REMOTE_NOT_FOUND]: The repository remote was not found.\n",
    });
  }, 30_000);
});

interface Fixture {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "git-storage-helper-fetch-"));
  directories.push(root);
  const helperDirectory = join(root, "bin");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${helperDirectory}:${process.env.PATH ?? ""}`,
    HOME: join(root, "home"),
    GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_GDRIVE_FILESYSTEM_STORE_DIR: join(root, "store"),
    GIT_GDRIVE_CONFIG_DIR: join(root, "config"),
  };
  await mkdir(helperDirectory, { recursive: true });
  await mkdir(environment.HOME!, { recursive: true });
  await writeFile(environment.GIT_CONFIG_GLOBAL!, "", { mode: 0o600 });
  if (sharedBuildDirectory === undefined) {
    throw new Error("The remote-helper executable was not built.");
  }
  const helper = join(sharedBuildDirectory, "bin/git-remote-gdrive.js");
  await symlink(helper, join(helperDirectory, "git-remote-gdrive"));
  return { root, environment };
}

async function initializeRemote(fixture: Fixture, name: string): Promise<string> {
  const runtime = createGitStorageRuntime({
    auth: filesystemOnlyAuth(),
    environment: fixture.environment,
    currentDirectory: fixture.root,
  });
  const remote = await runtime.application.createRemote(name);
  return `gdrive://${remote.remoteId}`;
}

function filesystemOnlyAuth(): AuthSession {
  return {
    login: async () => { throw new Error("OAuth must not run in remote-helper integration tests."); },
    status: async () => { throw new Error("OAuth must not run in remote-helper integration tests."); },
    logout: async () => { throw new Error("OAuth must not run in remote-helper integration tests."); },
    getAuthorizedClient: async () => { throw new Error("Drive must not run in remote-helper integration tests."); },
    getInstallationId: async () => "00000000-0000-4000-8000-000000000001",
  };
}

async function initRepository(fixture: Fixture, directory: string): Promise<void> {
  await git(fixture, fixture.root, ["init", "--initial-branch=main", directory]);
  await git(fixture, directory, ["config", "user.name", "Git Storage Test"]);
  await git(fixture, directory, ["config", "user.email", "git-storage@example.invalid"]);
}

async function commit(
  fixture: Fixture,
  repository: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(repository, filename), contents);
  await git(fixture, repository, ["add", "--", filename]);
  await git(fixture, repository, ["commit", "-m", message]);
  return git(fixture, repository, ["rev-parse", "HEAD"]);
}

async function git(fixture: Fixture, cwd: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await runGit(arguments_, cwd, fixture.environment);
  return stdout.trim();
}

function run(command: string, arguments_: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return execute(command, [...arguments_], { cwd, env: environment, encoding: "utf8" });
}

function runGit(arguments_: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...arguments_], { cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const standardOutput = Buffer.concat(stdout).toString("utf8");
      const standardError = Buffer.concat(stderr).toString("utf8");
      if (exitCode === 0) {
        resolvePromise({ stdout: standardOutput });
        return;
      }
      const error = Object.assign(new Error("Git command failed."), {
        exitCode: exitCode ?? 1,
        stdout: standardOutput,
        stderr: standardError,
      });
      reject(error);
    });
  });
}

async function runGitCapturingStderr(
  fixture: Fixture,
  cwd: string,
  arguments_: readonly string[],
): Promise<{ stdout: string }> {
  const stderrPath = join(fixture.root, "remote-helper.stderr");
  const stderrFile = await open(stderrPath, "w", 0o600);
  try {
    const result = await new Promise<{ stdout: string }>((resolvePromise, reject) => {
      const child = spawn("git", [...arguments_], {
        cwd,
        env: fixture.environment,
        shell: false,
        stdio: ["ignore", "pipe", stderrFile.fd],
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => {
        const standardOutput = Buffer.concat(stdout).toString("utf8");
        if (exitCode === 0) {
          resolvePromise({ stdout: standardOutput });
          return;
        }
        reject(Object.assign(new Error("Git command failed."), { exitCode: exitCode ?? 1, stdout: standardOutput }));
      });
    });
    return result;
  } catch (error) {
    const stderr = await readFile(stderrPath, "utf8");
    if (typeof error === "object" && error !== null) {
      Object.assign(error, { stderr });
    }
    throw error;
  } finally {
    await stderrFile.close();
    await rm(stderrPath, { force: true });
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  throw new Error("The interactive protocol did not respond in time.");
}
