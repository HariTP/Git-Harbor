import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { GitStorageError } from "../domain/errors.js";
import {
  parseRepositoryMetadata,
  serializeRepositoryMetadata,
  type ArtifactDescriptor,
  type RepositoryMetadata,
} from "../domain/metadata.js";
import type {
  RemoteDescriptor,
  RepositoryChange,
  RepositoryStore,
} from "./repository-store.js";

const safeIdentifier = /^[A-Za-z0-9_-]+$/;

export interface FilesystemRepositoryStoreOptions {
  readonly rootDirectory: string;
  readonly uuid?: () => string;
  readonly now?: () => string;
  readonly writerId?: string;
  readonly beforeMetadataPublication?: () => Promise<void> | void;
  readonly afterMetadataPublication?: () => Promise<void> | void;
}

/** Deterministic adapter for development and repository-store contract tests. */
export class FilesystemRepositoryStore implements RepositoryStore {
  private readonly rootDirectory: string;
  private readonly uuid: () => string;
  private readonly now: () => string;
  private readonly writerId: string;
  private readonly beforeMetadataPublication?: () => Promise<void> | void;
  private readonly afterMetadataPublication?: () => Promise<void> | void;

  constructor(options: FilesystemRepositoryStoreOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.uuid = options.uuid ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.writerId = options.writerId ?? "filesystem-development";
    this.beforeMetadataPublication = options.beforeMetadataPublication;
    this.afterMetadataPublication = options.afterMetadataPublication;
  }

  async create(displayName: string): Promise<RemoteDescriptor> {
    const remoteId = `repository-${this.identifier(this.uuid())}`;
    const directory = this.remoteDirectory(remoteId);
    const metadata = parseRepositoryMetadata({
      formatVersion: 2,
      repositoryId: this.uuid(),
      displayName,
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      refs: {},
      artifacts: [],
      generation: 1,
      updatedAt: this.now(),
      writerId: this.writerId,
    });

    let createdDirectory = false;
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await mkdir(directory, { recursive: false });
      createdDirectory = true;
      await mkdir(join(directory, "artifacts"));
      await this.writeMetadata(directory, metadata);
    } catch (error) {
      if (createdDirectory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { remoteId, metadata };
  }

  async readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    void resourceKey;
    try {
      const text = await readFile(join(this.remoteDirectory(remoteId), "repository.json"), "utf8");
      return { remoteId, metadata: parseRepositoryMetadata(JSON.parse(text)) };
    } catch (error) {
      if (isMissing(error)) throw remoteNotFound();
      if (error instanceof GitStorageError) throw error;
      throw invalidMetadata();
    }
  }

  async downloadArtifact(
    remote: RemoteDescriptor,
    artifact: ArtifactDescriptor,
    destination: string,
  ): Promise<void> {
    const source = this.artifactPath(remote.remoteId, artifact.storageKey);
    const temporary = this.destinationTemporaryPath(destination);
    try {
      await copyFile(source, temporary);
      const info = await stat(temporary);
      if (info.size !== artifact.size || await sha256File(temporary) !== artifact.sha256) {
        throw artifactCorrupt();
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      if (isMissing(error)) throw artifactMissing();
      throw error;
    }
  }

  async publish(remote: RemoteDescriptor, change: RepositoryChange): Promise<RemoteDescriptor> {
    const current = await this.readDescriptor(remote.remoteId);
    if (current.metadata.generation !== remote.metadata.generation) throw remoteChanged();

    let artifactDescriptor: ArtifactDescriptor | null = null;
    if (change.artifact !== null) {
      const artifactId = `artifact-${this.identifier(this.uuid())}`;
      const destination = this.artifactPath(remote.remoteId, artifactId);
      const temporary = `${destination}.${this.identifier(this.uuid())}.tmp`;
      try {
        await copyFile(change.artifact.path, temporary);
        const info = await stat(temporary);
        const digest = await sha256File(temporary);
        if (info.size !== change.artifact.size || digest !== change.artifact.sha256) {
          throw artifactCorrupt();
        }
        await rename(temporary, destination);
        artifactDescriptor = {
          id: artifactId,
          storageKey: artifactId,
          kind: change.artifact.kind,
          sha256: digest,
          size: info.size,
          prerequisites: change.artifact.prerequisites,
          heads: change.artifact.heads,
        };
      } finally {
        await rm(temporary, { force: true });
      }
    }

    await this.beforeMetadataPublication?.();
    const metadata = parseRepositoryMetadata({
      ...current.metadata,
      defaultBranch: change.defaultBranch,
      refs: change.refs,
      artifacts: artifactDescriptor === null
        ? current.metadata.artifacts
        : [...current.metadata.artifacts, artifactDescriptor],
      generation: current.metadata.generation + 1,
      updatedAt: this.now(),
      writerId: this.writerId,
    });
    await this.writeMetadata(this.remoteDirectory(remote.remoteId), metadata);
    await this.afterMetadataPublication?.();
    const reread = await this.readDescriptor(remote.remoteId);
    if (reread.metadata.generation !== metadata.generation ||
      reread.metadata.artifacts.length !== metadata.artifacts.length) {
      throw remoteChanged();
    }
    return reread;
  }

  private remoteDirectory(remoteId: string): string {
    return join(this.rootDirectory, this.identifier(remoteId));
  }

  private artifactPath(remoteId: string, artifactId: string): string {
    return join(this.remoteDirectory(remoteId), "artifacts", `${this.identifier(artifactId)}.bundle`);
  }

  private identifier(value: string): string {
    if (!safeIdentifier.test(value)) throw remoteNotFound();
    return value;
  }

  private async writeMetadata(directory: string, metadata: RepositoryMetadata): Promise<void> {
    const path = join(directory, "repository.json");
    const temporary = join(directory, `.repository-${this.identifier(this.uuid())}.json.tmp`);
    try {
      await writeFile(temporary, serializeRepositoryMetadata(metadata), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private destinationTemporaryPath(destination: string): string {
    return join(dirname(destination), `.${basename(destination)}.${this.identifier(this.uuid())}.tmp`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function remoteNotFound(): GitStorageError {
  return new GitStorageError("REMOTE_NOT_FOUND", "The repository remote was not found.");
}
function invalidMetadata(): GitStorageError {
  return new GitStorageError("REMOTE_METADATA_INVALID", "The repository metadata is invalid.");
}
function artifactMissing(): GitStorageError {
  return new GitStorageError("REMOTE_BUNDLE_MISSING", "The repository artifact is missing.");
}
function artifactCorrupt(): GitStorageError {
  return new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The repository artifact failed verification.");
}
function remoteChanged(): GitStorageError {
  return new GitStorageError("REMOTE_CHANGED_DURING_PUSH", "The remote changed during publication.");
}
