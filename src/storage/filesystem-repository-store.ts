import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { GitStorageError } from "../domain/errors.js";
import {
  parseRepositoryMetadata,
  serializeRepositoryMetadata,
  type RepositoryMetadata,
} from "../domain/metadata.js";
import type { RemoteDescriptor, RepositoryStore } from "./repository-store.js";

const safeIdentifier = /^[A-Za-z0-9_-]+$/;

export interface FilesystemRepositoryStoreOptions {
  readonly rootDirectory: string;
  readonly uuid?: () => string;
  readonly now?: () => string;
  readonly writerId?: string;
  /** Test-only fault injection at the safe-publication seam. */
  readonly beforeMetadataPublication?: () => Promise<void> | void;
  /** Test-only hook for simulating a concurrent metadata change. */
  readonly afterMetadataPublication?: () => Promise<void> | void;
}

/** A deterministic adapter for development and integration tests. */
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
    const metadata: RepositoryMetadata = parseRepositoryMetadata({
      formatVersion: 1,
      repositoryId: this.uuid(),
      displayName,
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      bundleFileId: null,
      bundleSha256: null,
      refs: {},
      generation: 1,
      updatedAt: this.now(),
      writerId: this.writerId,
    });

    let createdDirectory = false;
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await mkdir(directory, { recursive: false });
      createdDirectory = true;
      await mkdir(join(directory, "bundles"));
      await this.writeMetadata(directory, metadata);
    } catch (error) {
      if (createdDirectory) {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }

    return { remoteId, metadata };
  }

  async readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    void resourceKey;
    const directory = this.remoteDirectory(remoteId);
    let text: string;
    try {
      text = await readFile(join(directory, "repository.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw remoteNotFound();
      }
      throw error;
    }

    try {
      return { remoteId, metadata: parseRepositoryMetadata(JSON.parse(text)) };
    } catch (error) {
      if (error instanceof GitStorageError) {
        throw error;
      }
      throw invalidMetadata();
    }
  }

  async downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void> {
    const metadata = remote.metadata;
    if (metadata.bundleFileId === null || metadata.bundleSha256 === null) {
      throw bundleMissing();
    }

    const source = this.bundlePath(remote.remoteId, metadata.bundleFileId);
    const temporary = this.destinationTemporaryPath(destination);
    try {
      await copyFile(source, temporary);
      const digest = await sha256File(temporary);
      if (digest !== metadata.bundleSha256.toLowerCase()) {
        throw bundleCorrupt();
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      if (isMissing(error)) {
        throw bundleMissing();
      }
      throw error;
    }
  }

  async publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor> {
    const current = await this.readDescriptor(remote.remoteId);
    if (current.metadata.generation !== remote.metadata.generation) {
      throw remoteChanged();
    }
    const validatedNext = parseRepositoryMetadata(nextMetadata);
    const hasRefs = Object.keys(validatedNext.refs).length > 0;
    if (validatedNext.repositoryId !== current.metadata.repositoryId ||
      validatedNext.generation !== current.metadata.generation + 1 ||
      (bundlePath === null) !== !hasRefs) {
      throw invalidMetadata();
    }

    let bundleFileId: string | null = null;
    let bundleSha256: string | null = null;
    if (bundlePath !== null) {
      bundleFileId = `bundle-${this.identifier(this.uuid())}`;
      const destination = this.bundlePath(remote.remoteId, bundleFileId);
      const temporary = `${destination}.${this.identifier(this.uuid())}.tmp`;
      try {
        await copyFile(bundlePath, temporary);
        bundleSha256 = await sha256File(temporary);
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    await this.beforeMetadataPublication?.();

    const metadata = parseRepositoryMetadata({
      ...validatedNext,
      repositoryId: current.metadata.repositoryId,
      bundleFileId,
      bundleSha256,
      updatedAt: this.now(),
      writerId: this.writerId,
    });
    await this.writeMetadata(this.remoteDirectory(remote.remoteId), metadata);
    await this.afterMetadataPublication?.();
    const reread = await this.readDescriptor(remote.remoteId);
    if (reread.metadata.generation !== metadata.generation ||
      reread.metadata.bundleFileId !== metadata.bundleFileId) {
      throw remoteChanged();
    }
    return reread;
  }

  private remoteDirectory(remoteId: string): string {
    return join(this.rootDirectory, this.identifier(remoteId));
  }

  private bundlePath(remoteId: string, bundleId: string): string {
    return join(this.remoteDirectory(remoteId), "bundles", `${this.identifier(bundleId)}.bundle`);
  }

  private identifier(value: string): string {
    if (!safeIdentifier.test(value)) {
      throw remoteNotFound();
    }
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

function bundleMissing(): GitStorageError {
  return new GitStorageError("REMOTE_BUNDLE_MISSING", "The repository bundle is missing.");
}

function bundleCorrupt(): GitStorageError {
  return new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The repository bundle failed checksum verification.");
}

function remoteChanged(): GitStorageError {
  return new GitStorageError("REMOTE_CHANGED_DURING_PUSH", "The remote changed during publication.");
}
