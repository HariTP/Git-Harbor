import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { drive_v3 } from "googleapis";

import type { ArtifactDescriptor } from "../../src/domain/metadata.js";
import { serializeRepositoryMetadata } from "../../src/domain/metadata.js";
import { FilesystemRepositoryStore } from "../../src/storage/filesystem-repository-store.js";
import {
  createGoogleDriveExternalClient,
  GoogleDriveRepositoryStore,
} from "../../src/storage/google-drive-repository-store.js";
import type { LocalArtifact, RepositoryChange } from "../../src/storage/repository-store.js";
import { TestDriveClient } from "../support/test-repository-store.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-storage-store-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FilesystemRepositoryStore", () => {
  test("creates, publishes, and downloads immutable artifacts", async () => {
    const root = await temporaryDirectory();
    const source = join(await temporaryDirectory(), "base.bundle");
    const destination = join(await temporaryDirectory(), "download.bundle");
    await writeFile(source, "base artifact");
    const store = new FilesystemRepositoryStore({ rootDirectory: root, uuid: sequenceUuid(), writerId: "test" });
    const empty = await store.create("repo");
    const published = await store.publish(empty, populatedChange(localArtifact(source, "base artifact")));

    expect(empty.metadata).toMatchObject({ formatVersion: 2, generation: 1, artifacts: [], refs: {} });
    expect(published.metadata).toMatchObject({ generation: 2, refs: { "refs/heads/main": oid } });
    expect(published.metadata.artifacts).toHaveLength(1);
    await store.downloadArtifact(published, published.metadata.artifacts[0]!, destination);
    expect(await readFile(destination, "utf8")).toBe("base artifact");
  });

  test("appends artifacts and publishes ref-only deletion without removing history", async () => {
    const root = await temporaryDirectory();
    const firstPath = join(await temporaryDirectory(), "base.bundle");
    const secondPath = join(await temporaryDirectory(), "inc.bundle");
    await writeFile(firstPath, "base");
    await writeFile(secondPath, "incremental");
    const store = new FilesystemRepositoryStore({ rootDirectory: root, uuid: sequenceUuid(), writerId: "test" });
    const empty = await store.create("repo");
    const first = await store.publish(empty, populatedChange(localArtifact(firstPath, "base")));
    const nextOid = "1".repeat(40);
    const second = await store.publish(first, {
      artifact: localArtifact(secondPath, "incremental", "incremental", [oid], nextOid),
      refs: { "refs/heads/main": nextOid },
      defaultBranch: "refs/heads/main",
    });
    const deleted = await store.publish(second, {
      artifact: null,
      refs: {},
      defaultBranch: "refs/heads/main",
    });

    expect(second.metadata.artifacts).toHaveLength(2);
    expect(deleted.metadata).toMatchObject({ generation: 4, refs: {} });
    expect(deleted.metadata.artifacts).toHaveLength(2);
  });

  test("keeps prior metadata when publication is interrupted", async () => {
    const root = await temporaryDirectory();
    const path = join(await temporaryDirectory(), "base.bundle");
    await writeFile(path, "base");
    const stable = new FilesystemRepositoryStore({ rootDirectory: root, uuid: sequenceUuid(), writerId: "test" });
    const empty = await stable.create("repo");
    const interrupted = new FilesystemRepositoryStore({
      rootDirectory: root,
      uuid: sequenceUuid(),
      writerId: "test",
      beforeMetadataPublication: () => { throw new Error("interrupted"); },
    });

    await expect(interrupted.publish(empty, populatedChange(localArtifact(path, "base"))))
      .rejects.toThrow("interrupted");
    expect(await stable.readDescriptor(empty.remoteId)).toEqual(empty);
  });

  test("detects stale generations, corrupt downloads, and malformed metadata", async () => {
    const root = await temporaryDirectory();
    const path = join(await temporaryDirectory(), "base.bundle");
    await writeFile(path, "base");
    const store = new FilesystemRepositoryStore({ rootDirectory: root, uuid: sequenceUuid(), writerId: "test" });
    const empty = await store.create("repo");
    const published = await store.publish(empty, populatedChange(localArtifact(path, "base")));
    await expect(store.publish(empty, populatedChange(localArtifact(path, "base"))))
      .rejects.toMatchObject({ code: "REMOTE_CHANGED_DURING_PUSH" });

    const corrupt: ArtifactDescriptor = { ...published.metadata.artifacts[0]!, sha256: "f".repeat(64) };
    await expect(store.downloadArtifact(published, corrupt, join(await temporaryDirectory(), "bad.bundle")))
      .rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
    await writeFile(join(root, empty.remoteId, "repository.json"), "not json");
    await expect(store.readDescriptor(empty.remoteId)).rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
  });

  test("detects a descriptor changed immediately after publication", async () => {
    const root = await temporaryDirectory();
    const path = join(await temporaryDirectory(), "base.bundle");
    await writeFile(path, "base");
    const stable = new FilesystemRepositoryStore({ rootDirectory: root, uuid: sequenceUuid(), writerId: "test" });
    const empty = await stable.create("repo");
    const racing = new FilesystemRepositoryStore({
      rootDirectory: root,
      uuid: sequenceUuid(),
      writerId: "test",
      afterMetadataPublication: async () => {
        const changed = await stable.readDescriptor(empty.remoteId);
        await writeFile(join(root, empty.remoteId, "repository.json"), serializeRepositoryMetadata({
          ...changed.metadata,
          generation: changed.metadata.generation + 1,
        }));
      },
    });
    await expect(racing.publish(empty, populatedChange(localArtifact(path, "base"))))
      .rejects.toMatchObject({ code: "REMOTE_CHANGED_DURING_PUSH" });
  });
});

describe("GoogleDriveRepositoryStore", () => {
  test("serializes a validated resource-key route", async () => {
    let receivedOptions: unknown;
    const client = createGoogleDriveExternalClient({ files: {
      get: async (_input: unknown, options: unknown) => {
        receivedOptions = options;
        return { data: { id: "folder-id" } };
      },
    } } as unknown as drive_v3.Drive);
    await client.getFile({ fileId: "folder-id", routing: { folderId: "folder-id", resourceKey: "key_123" } });
    expect(receivedOptions).toEqual({ headers: { "X-Goog-Drive-Resource-Keys": "folder-id/key_123" } });
  });

  test("creates, publishes, and downloads a managed artifact", async () => {
    const path = join(await temporaryDirectory(), "base.bundle");
    const destination = join(await temporaryDirectory(), "download.bundle");
    await writeFile(path, "drive artifact");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("repo");
    const published = await store.publish(empty, populatedChange(localArtifact(path, "drive artifact")));
    await store.downloadArtifact(published, published.metadata.artifacts[0]!, destination);
    expect(await readFile(destination, "utf8")).toBe("drive artifact");
  });

  test("propagates resource keys through publication", async () => {
    const path = join(await temporaryDirectory(), "base.bundle");
    await writeFile(path, "drive artifact");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const created = await store.create("repo");
    drive.requireResourceKey(created.remoteId, "routing-key");
    const keyed = await store.readDescriptor(created.remoteId, "routing-key");
    const published = await store.publish(keyed, populatedChange(localArtifact(path, "drive artifact")));
    expect(published.resourceKey).toBe("routing-key");
  });

  test("leaves prior metadata visible when upload verification or publication fails", async () => {
    const path = join(await temporaryDirectory(), "base.bundle");
    await writeFile(path, "drive artifact");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid(), maxRetries: 0 });
    const empty = await store.create("repo");
    drive.corruptNextBundleReadback();
    await expect(store.publish(empty, populatedChange(localArtifact(path, "drive artifact"))))
      .rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(empty);

    drive.failNext("update", new Error("network"));
    await expect(store.publish(empty, populatedChange(localArtifact(path, "drive artifact"))))
      .rejects.toMatchObject({ code: "DRIVE_NETWORK_ERROR" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(empty);
  });

  test("retries rate limits and maps permission failures", async () => {
    const drive = new TestDriveClient();
    const sleeps: number[] = [];
    const store = new GoogleDriveRepositoryStore({
      drive, writerId: "test", uuid: sequenceUuid(), maxRetries: 1,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }, random: () => 0,
    });
    const remote = await store.create("repo");
    drive.failNext("get", { response: { status: 429 } });
    await expect(store.readDescriptor(remote.remoteId)).resolves.toEqual(remote);
    expect(sleeps).toEqual([100]);
    drive.failNext("get", { response: { status: 403 } });
    await expect(store.readDescriptor(remote.remoteId)).rejects.toMatchObject({ code: "DRIVE_PERMISSION_DENIED" });
  });
});

function populatedChange(artifact: LocalArtifact): RepositoryChange {
  return { artifact, refs: { "refs/heads/main": oid }, defaultBranch: "refs/heads/main" };
}

function localArtifact(
  path: string,
  content: string,
  kind: "base" | "incremental" = "base",
  prerequisites: readonly string[] = [],
  head = oid,
): LocalArtifact {
  return {
    path,
    kind,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    prerequisites,
    heads: { "refs/heads/main": head },
  };
}

function sequenceUuid(): () => string {
  let value = 0;
  return () => `123e4567-e89b-12d3-a456-426614174${String(value++).padStart(3, "0")}`;
}
