import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";

import type { drive_v3 } from "googleapis";

import { GitStorageError } from "../domain/errors.js";
import {
  parseRepositoryMetadata,
  serializeRepositoryMetadata,
  type ArtifactDescriptor,
  type RepositoryMetadata,
} from "../domain/metadata.js";
import type { RemoteDescriptor, RepositoryChange, RepositoryStore } from "./repository-store.js";

export interface DriveFile {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly mimeType?: string | null;
  readonly appProperties?: Readonly<Record<string, string>> | null;
  readonly size?: string | null;
  readonly md5Checksum?: string | null;
}

/** The only external seam used by the production adapter. */
export interface DriveExternalClient {
  createFile(input: DriveCreateFileInput): Promise<DriveFile>;
  getFile(input: DriveGetFileInput): Promise<DriveFile>;
  listFiles(input: DriveListFilesInput): Promise<readonly DriveFile[]>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  updateFile(input: DriveUpdateFileInput): Promise<DriveFile>;
}

export interface DriveResourceKeyRoute {
  readonly folderId: string;
  readonly resourceKey: string;
}

export interface DriveGetFileInput {
  readonly fileId: string;
  readonly routing?: DriveResourceKeyRoute;
}

export interface DriveCreateFileInput {
  readonly name: string;
  readonly mimeType: string;
  readonly parents?: readonly string[];
  readonly appProperties?: Readonly<Record<string, string>>;
  readonly content?: Uint8Array;
  readonly routing?: DriveResourceKeyRoute;
}

export interface DriveUpdateFileInput {
  readonly fileId: string;
  readonly content: Uint8Array;
}

export interface DriveListFilesInput {
  readonly parentId: string;
  readonly appProperties: Readonly<Record<string, string>>;
  readonly routing?: DriveResourceKeyRoute;
}

export interface GoogleDriveRepositoryStoreOptions {
  readonly drive: DriveExternalClient;
  readonly writerId: string;
  readonly uuid?: () => string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly parentFolderId?: string;
  readonly maxRetries?: number;
}

const folderMimeType = "application/vnd.google-apps.folder";
const jsonMimeType = "application/json";
const bundleMimeType = "application/octet-stream";
const formatVersion = "2";
const driveRoutingValuePattern = /^[A-Za-z0-9_-]+$/;

/**
 * Production Drive adapter. File IDs, not names, are authoritative after creation.
 */
export class GoogleDriveRepositoryStore implements RepositoryStore {
  private readonly drive: DriveExternalClient;
  private readonly writerId: string;
  private readonly uuid: () => string;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly parentFolderId?: string;
  private readonly maxRetries: number;

  constructor(options: GoogleDriveRepositoryStoreOptions) {
    this.drive = options.drive;
    this.writerId = options.writerId;
    this.uuid = options.uuid ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.parentFolderId = options.parentFolderId;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async create(displayName: string): Promise<RemoteDescriptor> {
    const repositoryId = this.uuid();
    const metadata = parseRepositoryMetadata({
      formatVersion: 2,
      repositoryId,
      displayName,
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      refs: {},
      artifacts: [],
      generation: 1,
      updatedAt: this.now(),
      writerId: this.writerId,
    });
    const folder = await this.call(() => this.drive.createFile({
      name: displayName,
      mimeType: folderMimeType,
      parents: this.parentFolderId === undefined ? undefined : [this.parentFolderId],
      appProperties: managedProperties(repositoryId),
    }));
    const remoteId = requiredFileId(folder, "REMOTE_NOT_FOUND");
    await this.call(() => this.drive.createFile({
      name: "repository.json",
      mimeType: jsonMimeType,
      parents: [remoteId],
      appProperties: managedProperties(repositoryId, "metadata"),
      content: Buffer.from(serializeRepositoryMetadata(metadata)),
    }));
    return { remoteId, metadata };
  }

  async readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    const routing = makeResourceKeyRoute(remoteId, resourceKey);
    const folder = await this.call(() => this.drive.getFile({ fileId: remoteId, routing }), "REMOTE_NOT_FOUND");
    if (folder.mimeType !== folderMimeType) {
      throw remoteNotFound();
    }
    const metadataFile = await this.findMetadata(remoteId, routing);
    const metadata = await this.readMetadata(metadataFile);
    const repositoryId = metadataFile.appProperties?.["gitStorage.repositoryId"];
    if (repositoryId !== metadata.repositoryId) {
      throw invalidMetadata();
    }
    return {
      remoteId,
      metadata,
      ...(resourceKey === undefined ? {} : { resourceKey }),
    };
  }

  async downloadArtifact(
    remote: RemoteDescriptor,
    artifact: ArtifactDescriptor,
    destination: string,
  ): Promise<void> {
    const file = await this.call(() => this.drive.getFile({ fileId: artifact.storageKey }), "REMOTE_BUNDLE_MISSING");
    if (!isManagedArtifact(file, remote.metadata.repositoryId, artifact.id)) {
      throw bundleCorrupt();
    }
    const bytes = await this.call(() => this.drive.downloadFile(requiredFileId(file, "REMOTE_BUNDLE_MISSING")), "REMOTE_BUNDLE_MISSING");
    if (bytes.byteLength !== artifact.size ||
      (file.size !== undefined && file.size !== null && Number(file.size) !== bytes.byteLength)) {
      throw bundleCorrupt();
    }
    if (sha256(bytes) !== artifact.sha256) {
      throw bundleCorrupt();
    }
    await writeVerifiedDestination(destination, bytes, this.uuid);
  }

  async publish(remote: RemoteDescriptor, change: RepositoryChange): Promise<RemoteDescriptor> {
    const current = await this.readDescriptor(remote.remoteId, remote.resourceKey);
    if (current.metadata.generation !== remote.metadata.generation) {
      throw remoteChanged();
    }

    let artifactDescriptor: ArtifactDescriptor | null = null;
    if (change.artifact !== null) {
      const bytes = await readFile(change.artifact.path);
      if (bytes.byteLength !== change.artifact.size || sha256(bytes) !== change.artifact.sha256) {
        throw bundleCorrupt();
      }
      const artifactId = `artifact-${this.uuid()}`;
      const bundle = await this.call(() => this.drive.createFile({
        name: `${artifactId}.bundle`,
        mimeType: bundleMimeType,
        parents: [remote.remoteId],
        appProperties: managedProperties(current.metadata.repositoryId, "artifact", artifactId),
        content: bytes,
        routing: makeResourceKeyRoute(remote.remoteId, remote.resourceKey),
      }));
      const storageKey = requiredFileId(bundle, "REMOTE_BUNDLE_MISSING");
      const uploadedBundle = await this.call(
        () => this.drive.getFile({ fileId: storageKey }),
        "REMOTE_BUNDLE_MISSING",
      );
      await this.verifyUploadedBundle(uploadedBundle, bytes);
      artifactDescriptor = {
        id: artifactId,
        storageKey,
        kind: change.artifact.kind,
        sha256: change.artifact.sha256,
        size: change.artifact.size,
        prerequisites: change.artifact.prerequisites,
        heads: change.artifact.heads,
      };
    }

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
    const metadataFile = await this.findMetadata(
      remote.remoteId,
      makeResourceKeyRoute(remote.remoteId, remote.resourceKey),
    );
    await this.call(() => this.drive.updateFile({
      fileId: requiredFileId(metadataFile, "REMOTE_NOT_FOUND"),
      content: Buffer.from(serializeRepositoryMetadata(metadata)),
    }));
    const reread = await this.readDescriptor(remote.remoteId, remote.resourceKey);
    if (reread.metadata.generation !== metadata.generation ||
      reread.metadata.artifacts.length !== metadata.artifacts.length) {
      throw remoteChanged();
    }
    return reread;
  }

  private async findMetadata(remoteId: string, routing?: DriveResourceKeyRoute): Promise<DriveFile> {
    const files = await this.call(() => this.drive.listFiles({
      parentId: remoteId,
      appProperties: {
        "gitStorage.role": "metadata",
      },
      routing,
    }), "REMOTE_NOT_FOUND");
    if (files.length !== 1) {
      throw remoteNotFound();
    }
    return files[0];
  }

  private async readMetadata(file: DriveFile): Promise<RepositoryMetadata> {
    const fileId = requiredFileId(file, "REMOTE_NOT_FOUND");
    const bytes = await this.call(() => this.drive.downloadFile(fileId), "REMOTE_NOT_FOUND");
    try {
      return parseRepositoryMetadata(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch (error) {
      if (error instanceof GitStorageError) {
        throw error;
      }
      throw invalidMetadata();
    }
  }

  private async verifyUploadedBundle(file: DriveFile, bytes: Uint8Array): Promise<void> {
    if (file.size !== undefined && file.size !== null && Number(file.size) !== bytes.byteLength) {
      throw bundleCorrupt();
    }
    if (file.md5Checksum !== undefined && file.md5Checksum !== null && md5(bytes) !== file.md5Checksum) {
      throw bundleCorrupt();
    }
  }

  private async call<T>(operation: () => Promise<T>, missingCode?: "REMOTE_NOT_FOUND" | "REMOTE_BUNDLE_MISSING"): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const status = statusCode(error);
        if (status === 401) {
          throw new GitStorageError("AUTH_REQUIRED", "Google Drive authentication expired.");
        }
        if (status === 404 && missingCode !== undefined) {
          throw missingCode === "REMOTE_BUNDLE_MISSING" ? bundleMissing() : remoteNotFound();
        }
        if (status === 403) {
          throw new GitStorageError("DRIVE_PERMISSION_DENIED", "Google Drive permission was denied.");
        }
        if (!isRetryable(error) || attempt >= this.maxRetries) {
          if (status === 429) {
            throw new GitStorageError("DRIVE_RATE_LIMITED", "Google Drive rate limit was reached.");
          }
          throw new GitStorageError("DRIVE_NETWORK_ERROR", "Google Drive could not be reached.");
        }
        const jitter = Math.floor(this.random() * 100);
        await this.sleep(Math.min(2_000, 100 * 2 ** attempt + jitter));
        attempt += 1;
      }
    }
  }
}

/** Wrap the current googleapis Drive v3 surface in the deliberately narrow external seam. */
export function createGoogleDriveExternalClient(drive: drive_v3.Drive): DriveExternalClient {
  return {
    async createFile(input): Promise<DriveFile> {
      const response = await drive.files.create({
        requestBody: {
          name: input.name,
          mimeType: input.mimeType,
          parents: input.parents === undefined ? undefined : [...input.parents],
          appProperties: input.appProperties === undefined ? undefined : { ...input.appProperties },
        },
        media: input.content === undefined ? undefined : { mimeType: input.mimeType, body: Readable.from(input.content) },
        fields: "id,name,mimeType,appProperties,size,md5Checksum",
      }, requestOptions(input.routing));
      return response.data;
    },
    async getFile(input): Promise<DriveFile> {
      const response = await drive.files.get({
        fileId: input.fileId,
        fields: "id,name,mimeType,appProperties,size,md5Checksum",
      }, requestOptions(input.routing));
      return response.data;
    },
    async listFiles(input): Promise<readonly DriveFile[]> {
      const properties = Object.entries(input.appProperties)
        .map(([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`)
        .join(" and ");
      const response = await drive.files.list({
        q: `'${escapeQuery(input.parentId)}' in parents and trashed = false and ${properties}`,
        fields: "files(id,name,mimeType,appProperties,size,md5Checksum)",
      }, requestOptions(input.routing));
      return response.data.files ?? [];
    },
    async downloadFile(fileId): Promise<Uint8Array> {
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      return new Uint8Array(response.data as ArrayBuffer);
    },
    async updateFile(input): Promise<DriveFile> {
      const response = await drive.files.update({
        fileId: input.fileId,
        media: { mimeType: jsonMimeType, body: Readable.from(input.content) },
        fields: "id,name,mimeType,appProperties,size,md5Checksum",
      });
      return response.data;
    },
  };
}

function managedProperties(
  repositoryId: string,
  role?: "metadata" | "artifact",
  artifactId?: string,
): Record<string, string> {
  return {
    "gitStorage.repositoryId": repositoryId,
    "gitStorage.formatVersion": formatVersion,
    ...(role === undefined ? {} : { "gitStorage.role": role }),
    ...(artifactId === undefined ? {} : { "gitStorage.artifactId": artifactId }),
  };
}

function isManagedArtifact(file: DriveFile, repositoryId: string, artifactId: string): boolean {
  return file.appProperties?.["gitStorage.repositoryId"] === repositoryId &&
    file.appProperties["gitStorage.role"] === "artifact" &&
    file.appProperties["gitStorage.artifactId"] === artifactId &&
    file.appProperties["gitStorage.formatVersion"] === formatVersion;
}

function requiredFileId(file: DriveFile, code: "REMOTE_NOT_FOUND" | "REMOTE_BUNDLE_MISSING"): string {
  if (typeof file.id !== "string" || file.id.length === 0) {
    throw code === "REMOTE_BUNDLE_MISSING" ? bundleMissing() : remoteNotFound();
  }
  return file.id;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

async function writeVerifiedDestination(destination: string, bytes: Uint8Array, uuid: () => string): Promise<void> {
  const temporary = join(dirname(destination), `.${basename(destination)}.${uuid()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (typeof response?.status === "number") {
    return response.status;
  }
  return typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : undefined;
}

function isRetryable(error: unknown): boolean {
  const status = statusCode(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
  return new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The repository bundle failed verification.");
}

function remoteChanged(): GitStorageError {
  return new GitStorageError("REMOTE_CHANGED_DURING_PUSH", "The remote changed during publication.");
}

function makeResourceKeyRoute(folderId: string, resourceKey?: string): DriveResourceKeyRoute | undefined {
  if (resourceKey === undefined) {
    return undefined;
  }
  validateResourceKeyRoute(folderId, resourceKey);
  return { folderId, resourceKey };
}

function validateResourceKeyRoute(folderId: string, resourceKey: string): void {
  if (!driveRoutingValuePattern.test(folderId) || !driveRoutingValuePattern.test(resourceKey)) {
    throw new GitStorageError("REMOTE_URL_INVALID", "The Drive remote URL is invalid.");
  }
}

function requestOptions(routing?: DriveResourceKeyRoute): { readonly headers: Readonly<Record<string, string>> } | undefined {
  if (routing === undefined) {
    return undefined;
  }
  validateResourceKeyRoute(routing.folderId, routing.resourceKey);
  return {
    headers: {
      "X-Goog-Drive-Resource-Keys": `${routing.folderId}/${routing.resourceKey}`,
    },
  };
}
