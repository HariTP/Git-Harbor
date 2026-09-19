import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createGitStorageRuntime } from "../../src/application/runtime.js";
import type { AuthSession } from "../../src/auth/auth-session.js";
import { RemoteHelperSession } from "../../src/remote-helper/remote-helper-session.js";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directories: string[] = [];
let sharedBuildRoot: string | undefined;
let sharedBuildDirectory: string | undefined;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeAll(async () => {
  sharedBuildRoot = await mkdtemp(join(tmpdir(), "git-storage-helper-push-build-"));
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

describe("git-remote-gdrive push protocol", () => {
  test("serializes a per-ref rejected push result with exact blank-line framing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { stdout += chunk; });
    const session = new RemoteHelperSession({
      remoteId: "remote",
      gitDirectory: "/tmp/repository.git",
      application: {
        listRemote: async () => ({ defaultBranch: "refs/heads/main", refs: [] }),
        fetch: async () => undefined,
        push: async () => [{ destination: "refs/heads/main", ok: false, reason: "NON_FAST_FORWARD" }],
      },
    });

    const running = session.run(input, output);
    input.end("push divergent:refs/heads/main\n\n");
    await running;

    expect(stdout).toBe("error refs/heads/main NON_FAST_FORWARD\n\n");
  });

  test("pushes initial and fast-forward history, branches, and lightweight and annotated tags", async () => {
    const fixture = await createFixture();
    const remote = await initializeRemote(fixture, "push-remote");
    const source = join(fixture.root, "source");
    await initRepository(fixture, source);
    const initial = await commit(fixture, source, "readme.txt", "first\n", "first");
    await git(fixture, source, ["remote", "add", "origin", remote]);

    await git(fixture, source, ["push", "-u", "origin", "main"]);
    const next = await commit(fixture, source, "readme.txt", "second\n", "second");
    await git(fixture, source, ["push", "origin", "main"]);
    await git(fixture, source, ["switch", "-c", "feature", initial]);
    const feature = await commit(fixture, source, "feature.txt", "feature\n", "feature");
    await git(fixture, source, ["tag", "v-light"]);
    await git(fixture, source, ["tag", "-a", "v-annotated", "-m", "annotated tag", "main"]);
    await git(fixture, source, ["push", "-u", "origin", "feature"]);
    await git(fixture, source, ["push", "origin", "v-light", "v-annotated"]);

    const restored = join(fixture.root, "restored");
    await git(fixture, fixture.root, ["clone", remote, restored]);
    expect(await git(fixture, restored, ["rev-parse", "refs/remotes/origin/feature"])).toBe(feature);
    expect(await git(fixture, restored, ["rev-parse", "refs/remotes/origin/main"])).toBe(next);
    expect(await git(fixture, restored, ["rev-parse", "refs/tags/v-light"])).toBe(feature);
    await expect(git(fixture, restored, ["rev-parse", "refs/tags/v-annotated^{commit}"])).resolves.toBe(next);
    await expect(git(fixture, restored, ["fsck", "--full"])).resolves.toBe("");
  }, 30_000);

  test("rejects a genuine non-fast-forward, accepts explicit force, deletes a branch, and preserves unrelated refs", async () => {
    const fixture = await createFixture();
    const remote = await initializeRemote(fixture, "force-remote");
    const source = join(fixture.root, "source");
    await initRepository(fixture, source);
    const base = await commit(fixture, source, "readme.txt", "base\n", "base");
    await git(fixture, source, ["remote", "add", "origin", remote]);
    await git(fixture, source, ["push", "-u", "origin", "main"]);
    await git(fixture, source, ["switch", "-c", "keep", base]);
    const keep = await commit(fixture, source, "keep.txt", "keep\n", "keep");
    await git(fixture, source, ["push", "-u", "origin", "keep"]);
    await git(fixture, source, ["switch", "main"]);
    const remoteMain = await commit(fixture, source, "readme.txt", "remote\n", "remote update");
    await git(fixture, source, ["push", "origin", "main"]);
    await git(fixture, source, ["switch", "-c", "divergent", base]);
    const divergent = await commit(fixture, source, "readme.txt", "divergent\n", "divergent update");

    await expect(git(fixture, source, ["push", "origin", "divergent:main"])).rejects.toMatchObject({
      stderr: expect.stringContaining("(non-fast-forward)"),
    });
    await git(fixture, source, ["push", "origin", "+divergent:main"]);
    await git(fixture, source, ["push", "origin", ":keep"]);

    const restored = join(fixture.root, "restored");
    await git(fixture, fixture.root, ["clone", remote, restored]);
    expect(await git(fixture, restored, ["rev-parse", "HEAD"])).toBe(divergent);
    expect(await git(fixture, restored, ["rev-parse", "refs/remotes/origin/main"])).toBe(divergent);
    expect(await ref(fixture, restored, "refs/remotes/origin/keep")).toBeNull();
    expect(remoteMain).not.toBe(divergent);
    expect(keep).not.toBe(divergent);
    await expect(git(fixture, restored, ["fsck", "--full"])).resolves.toContain("dangling commit");
  }, 30_000);
});

interface Fixture {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "git-storage-helper-push-"));
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

async function ref(fixture: Fixture, repository: string, name: string): Promise<string | null> {
  try {
    return await git(fixture, repository, ["rev-parse", "--verify", name]);
  } catch {
    return null;
  }
}

async function git(fixture: Fixture, cwd: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await run("git", arguments_, cwd, fixture.environment);
  return stdout.trim();
}

function run(command: string, arguments_: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return execute(command, [...arguments_], { cwd, env: environment, encoding: "utf8" });
}
