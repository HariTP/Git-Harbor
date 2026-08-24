import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface GitFixture {
  readonly root: string;
  readonly repository: string;
  readonly environment: NodeJS.ProcessEnv;
  git(directory: string, args: readonly string[]): Promise<string>;
  commit(filename: string, contents: string, message: string): Promise<string>;
  createBranch(name: string, startPoint?: string): Promise<void>;
  objectId(revision: string): Promise<string>;
  ref(name: string): Promise<string | null>;
}

export async function withGitFixture<T>(action: (fixture: GitFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "git-storage-bundle-test-"));
  const home = join(root, "home");
  const globalConfig = join(root, "global.gitconfig");
  const repository = join(root, "source");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };

  await mkdir(home, { recursive: true });
  await writeFile(globalConfig, "", { mode: 0o600 });
  await git(environment, root, ["init", "--initial-branch=main", repository]);
  await git(environment, repository, ["config", "user.name", "Git Storage Test"]);
  await git(environment, repository, ["config", "user.email", "git-storage@example.invalid"]);

  const fixture: GitFixture = {
    root,
    repository,
    environment,
    git: async (directory, args) => git(environment, directory, args),
    commit: async (filename, contents, message) => {
      const path = join(repository, filename);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, contents);
      await git(environment, repository, ["add", "--", filename]);
      await git(environment, repository, ["commit", "-m", message]);
      return git(environment, repository, ["rev-parse", "HEAD"]);
    },
    createBranch: async (name, startPoint) => {
      await git(environment, repository, ["branch", name, ...(startPoint === undefined ? [] : [startPoint])]);
    },
    objectId: async (revision) => git(environment, repository, ["rev-parse", "--verify", `${revision}^{object}`]),
    ref: async (name) => {
      try {
        return await git(environment, repository, ["rev-parse", "--verify", name]);
      } catch {
        return null;
      }
    },
  };

  try {
    return await action(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(
  environment: NodeJS.ProcessEnv,
  directory: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execute("git", [...args], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
  });
  return stdout.trim();
}
