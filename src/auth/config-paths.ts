import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigPaths {
  readonly root: string;
  readonly oauthClient: string;
  readonly token: string;
  readonly installation: string;
}

export interface ConfigPathOptions {
  readonly configRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

export function resolveConfigPaths(options: ConfigPathOptions = {}): ConfigPaths {
  const root = options.configRoot ?? resolveConfigRoot(options);

  return {
    root,
    oauthClient: join(root, "oauth-client.json"),
    token: join(root, "token.json"),
    installation: join(root, "installation.json"),
  };
}

export function resolveConfigRoot(options: ConfigPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const configuredRoot = environment.GIT_GDRIVE_CONFIG_DIR;

  if (configuredRoot && configuredRoot.trim().length > 0) {
    return configuredRoot;
  }

  if (platform === "win32") {
    return join(environment.APPDATA || join(homeDirectory, "AppData", "Roaming"), "git-storage");
  }

  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "git-storage");
  }

  return join(environment.XDG_CONFIG_HOME || join(homeDirectory, ".config"), "git-storage");
}
