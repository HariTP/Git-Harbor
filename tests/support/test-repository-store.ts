import { createHash } from "node:crypto";

import type {
  DriveCreateFileInput,
  DriveExternalClient,
  DriveFile,
  DriveGetFileInput,
  DriveListFilesInput,
  DriveResourceKeyRoute,
  DriveUpdateFileInput,
} from "../../src/storage/google-drive-repository-store.js";

interface StoredFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly appProperties: Readonly<Record<string, string>>;
  content: Uint8Array;
  size: string;
  md5Checksum: string;
}

/** Deterministic external Drive seam for repository-store tests. */
export class TestDriveClient implements DriveExternalClient {
  private readonly files = new Map<string, StoredFile>();
  private readonly failures = new Map<string, unknown[]>();
  private readonly requiredResourceKeys = new Map<string, string>();
  private corruptNextBundleRead = false;
  private mismatchNextBundleProperties = false;
  private externalCallsRejected = false;
  private bundleUploadsRejected = false;
  private counter = 0;

  requireResourceKey(folderId: string, resourceKey: string): void {
    this.requiredResourceKeys.set(folderId, resourceKey);
  }

  rejectAllExternalCalls(): void {
    this.externalCallsRejected = true;
  }

  rejectBundleUploads(): void {
    this.bundleUploadsRejected = true;
  }

  failNext(operation: string, error: unknown): void {
    const queued = this.failures.get(operation) ?? [];
    queued.push(error);
    this.failures.set(operation, queued);
  }

  corruptNextBundleReadback(): void {
    this.corruptNextBundleRead = true;
  }

  mismatchNextBundleManagedProperties(): void {
    this.mismatchNextBundleProperties = true;
  }

  async createFile(input: DriveCreateFileInput): Promise<DriveFile> {
    this.ensureExternalCallsAllowed();
    if (input.name.endsWith(".bundle") && this.bundleUploadsRejected) {
      throw new Error("bundle upload was not expected");
    }
    for (const parent of input.parents ?? []) {
      this.requireExpectedRoute(parent, input.routing);
    }
    validateManagedProperties(input);
    this.throwQueued("create");
    const id = `file-${++this.counter}`;
    const content = input.content === undefined ? new Uint8Array() : new Uint8Array(input.content);
    const file: StoredFile = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      parents: input.parents ?? [],
      appProperties: input.appProperties ?? {},
      content,
      size: String(content.byteLength),
      md5Checksum: createHash("md5").update(content).digest("hex"),
    };
    this.files.set(id, file);
    return publicFile(file);
  }

  async getFile(input: DriveGetFileInput): Promise<DriveFile> {
    this.ensureExternalCallsAllowed();
    this.requireExpectedRoute(input.fileId, input.routing);
    this.throwQueued("get");
    const file = this.required(input.fileId);
    if (this.corruptNextBundleRead && file.name.endsWith(".bundle")) {
      this.corruptNextBundleRead = false;
      return { ...publicFile(file), size: String(file.content.byteLength + 1) };
    }
    if (this.mismatchNextBundleProperties && file.name.endsWith(".bundle")) {
      this.mismatchNextBundleProperties = false;
      return {
        ...publicFile(file),
        appProperties: { ...file.appProperties, "gitStorage.repositoryId": "different-repository" },
      };
    }
    return publicFile(file);
  }

  async listFiles(input: DriveListFilesInput): Promise<readonly DriveFile[]> {
    this.ensureExternalCallsAllowed();
    this.requireExpectedRoute(input.parentId, input.routing);
    this.throwQueued("list");
    return [...this.files.values()]
      .filter((file) => file.parents.includes(input.parentId))
      .filter((file) => Object.entries(input.appProperties).every(([key, value]) => file.appProperties?.[key] === value))
      .map(publicFile);
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    this.ensureExternalCallsAllowed();
    this.throwQueued("download");
    return new Uint8Array(this.required(fileId).content);
  }

  async updateFile(input: DriveUpdateFileInput): Promise<DriveFile> {
    this.ensureExternalCallsAllowed();
    this.throwQueued("update");
    const file = this.required(input.fileId);
    file.content = new Uint8Array(input.content);
    file.size = String(file.content.byteLength);
    file.md5Checksum = createHash("md5").update(file.content).digest("hex");
    return publicFile(file);
  }

  private required(fileId: string): StoredFile {
    const file = this.files.get(fileId);
    if (file === undefined) {
      throw { response: { status: 404 } };
    }
    return file;
  }

  private throwQueued(operation: string): void {
    const queued = this.failures.get(operation);
    const failure = queued?.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  private ensureExternalCallsAllowed(): void {
    if (this.externalCallsRejected) {
      throw new Error("an external Drive call was not expected");
    }
  }

  private requireExpectedRoute(folderId: string, routing?: DriveResourceKeyRoute): void {
    const expected = this.requiredResourceKeys.get(folderId);
    if (expected !== undefined &&
      (routing?.folderId !== folderId || routing.resourceKey !== expected)) {
      throw { response: { status: 404 } };
    }
  }
}

function validateManagedProperties(input: DriveCreateFileInput): void {
  const properties = input.appProperties;
  if (input.mimeType === "application/vnd.google-apps.folder") {
    if (properties?.["gitStorage.repositoryId"] === undefined ||
      properties["gitStorage.formatVersion"] !== "2" ||
      properties["gitStorage.role"] !== undefined) {
      throw new Error("invalid managed folder properties");
    }
    return;
  }
  const expectedRole = input.name === "repository.json" ? "metadata"
    : input.name.endsWith(".bundle") ? "artifact" : undefined;
  if (expectedRole !== undefined &&
    (properties?.["gitStorage.repositoryId"] === undefined ||
      properties["gitStorage.formatVersion"] !== "2" ||
      properties["gitStorage.role"] !== expectedRole ||
      (expectedRole === "artifact" && properties["gitStorage.artifactId"] === undefined))) {
    throw new Error("invalid managed file properties");
  }
}

function publicFile(file: StoredFile): DriveFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    appProperties: file.appProperties,
    size: file.size,
    md5Checksum: file.md5Checksum,
  };
}
