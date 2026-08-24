import { mkdir, mkdtemp, rm, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface IsolatedEnvironment {
  readonly root: string;
  readonly configDir: string;
  writeFile(relativePath: string, contents: string): Promise<string>;
}

const isolatedVariables = ["GIT_GDRIVE_CONFIG_DIR", "HOME", "XDG_CONFIG_HOME", "APPDATA"] as const;

export async function withIsolatedEnvironment<T>(
  action: (environment: IsolatedEnvironment) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "git-storage-test-"));
  const configDir = join(root, "config");
  const previous = new Map<string, string | undefined>(
    isolatedVariables.map((name) => [name, process.env[name]]),
  );

  process.env.GIT_GDRIVE_CONFIG_DIR = configDir;
  process.env.HOME = join(root, "home");
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;

  try {
    return await action({
      root,
      configDir,
      writeFile: async (relativePath, contents) => {
        const path = join(root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await write(path, contents, { mode: 0o600 });
        return path;
      },
    });
  } finally {
    for (const name of isolatedVariables) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(root, { force: true, recursive: true });
  }
}
