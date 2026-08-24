import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";

import { google } from "googleapis";

import { createAuthSession, type AuthSession } from "../auth/auth-session.js";
import { GitStorageError } from "../domain/errors.js";
import { GitProcess } from "../git/git-process.js";
import { GitRepositoryEngine } from "../git/git-repository-engine.js";
import { FilesystemRepositoryStore } from "../storage/filesystem-repository-store.js";
import {
  createGoogleDriveExternalClient,
  GoogleDriveRepositoryStore,
} from "../storage/google-drive-repository-store.js";
import type { RemoteDescriptor, RepositoryStore } from "../storage/repository-store.js";
import type { RepositoryMetadata } from "../domain/metadata.js";
import {
  GitStorageApplication,
  type DoctorCheck,
} from "./git-storage-application.js";

export interface GitStorageRuntime {
  readonly auth: AuthSession;
  readonly application: GitStorageApplication;
}

export interface GitStorageRuntimeOptions {
  readonly auth?: AuthSession;
  readonly environment?: NodeJS.ProcessEnv;
  readonly currentDirectory?: string;
}

/** Shared production composition root for both npm executables. */
export function createGitStorageRuntime(
  options: GitStorageRuntimeOptions = {},
): GitStorageRuntime {
  const auth = options.auth ?? createAuthSession();
  const environment = options.environment ?? process.env;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const store = new LazyRepositoryStore(() => createRepositoryStore(auth, environment));
  const application = new GitStorageApplication({
    store,
    git: new GitRepositoryEngine(),
    doctorChecks: createDoctorChecks(auth, environment, currentDirectory),
  });

  return { auth, application };
}

class LazyRepositoryStore implements RepositoryStore {
  private storePromise: Promise<RepositoryStore> | undefined;

  constructor(private readonly createStore: () => Promise<RepositoryStore>) {}

  create(displayName: string): Promise<RemoteDescriptor> {
    return this.store().then((store) => store.create(displayName));
  }

  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    return this.store().then((store) => store.readDescriptor(remoteId, resourceKey));
  }

  downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void> {
    return this.store().then((store) => store.downloadBundle(remote, destination));
  }

  publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor> {
    return this.store().then((store) => store.publish(remote, bundlePath, nextMetadata));
  }

  private store(): Promise<RepositoryStore> {
    this.storePromise ??= this.createStore();
    return this.storePromise;
  }
}

async function createRepositoryStore(
  auth: AuthSession,
  environment: NodeJS.ProcessEnv,
): Promise<RepositoryStore> {
  const writerId = await auth.getInstallationId();
  const filesystemRoot = environment.GIT_GDRIVE_FILESYSTEM_STORE_DIR;
  if (filesystemRoot !== undefined && filesystemRoot.trim().length > 0) {
    return new FilesystemRepositoryStore({ rootDirectory: filesystemRoot, writerId });
  }

  const client = await auth.getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });
  return new GoogleDriveRepositoryStore({
    drive: createGoogleDriveExternalClient(drive),
    writerId,
  });
}

function createDoctorChecks(
  auth: AuthSession,
  environment: NodeJS.ProcessEnv,
  currentDirectory: string,
): readonly DoctorCheck[] {
  let statusPromise: ReturnType<AuthSession["status"]> | undefined;
  let authorizedClientPromise: ReturnType<AuthSession["getAuthorizedClient"]> | undefined;
  const status = () => (statusPromise ??= auth.status());
  const authorizedClient = () =>
    (authorizedClientPromise ??= auth.getAuthorizedClient());

  return [
    {
      name: "Node.js >= 22",
      required: true,
      check: async () => {
        if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22) {
          throw new Error("unsupported Node.js");
        }
      },
    },
    {
      name: "Git executable",
      required: true,
      check: async () => {
        await new GitProcess().run(["--version"], { cwd: currentDirectory });
      },
    },
    {
      name: "OAuth credentials",
      required: true,
      check: async () => {
        if (!(await status()).hasCredentials) {
          throw new GitStorageError(
            "AUTH_CREDENTIALS_MISSING",
            "OAuth client credentials were not found.",
          );
        }
      },
    },
    {
      name: "Refreshable token",
      required: true,
      check: async () => {
        if (!(await status()).isUsable) {
          throw new GitStorageError("AUTH_REQUIRED", "Sign in is required.");
        }
      },
    },
    {
      name: "Google Drive API",
      required: true,
      check: async () => {
        const client = await authorizedClient();
        await google
          .drive({ version: "v3", auth: client })
          .files.list({ pageSize: 1, spaces: "drive", fields: "files(id)" });
      },
    },
    ...["git-gdrive", "git-remote-gdrive"].map(
      (name): DoctorCheck => ({
        name: `${name} executable`,
        required: true,
        check: async () => {
          await requireExecutable(name, environment);
        },
      }),
    ),
  ];
}

async function requireExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const pathEntries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(
        directory,
        process.platform === "win32" && extname(name) === "" ? `${name}${extension}` : name,
      );
      try {
        await access(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return;
      } catch {
        // Try the next explicit PATH candidate.
      }
    }
  }

  throw new Error(`${name} was not found on PATH`);
}
