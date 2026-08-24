import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type { drive_v3 } from "googleapis";

import { FilesystemRepositoryStore } from "../../src/storage/filesystem-repository-store.js";
import {
  createGoogleDriveExternalClient,
  GoogleDriveRepositoryStore,
} from "../../src/storage/google-drive-repository-store.js";
import { serializeRepositoryMetadata, type RepositoryMetadata } from "../../src/domain/metadata.js";
import { TestDriveClient } from "../support/test-repository-store.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-storage-store-"));
  directories.push(directory);
  return directory;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FilesystemRepositoryStore", () => {
  test("creates and reads a remote with the default UUID generator", async () => {
    const rootDirectory = await temporaryDirectory();
    const store = new FilesystemRepositoryStore({ rootDirectory, writerId: "test-installation" });

    const created = await store.create("my-repository");

    expect(await store.readDescriptor(created.remoteId)).toEqual(created);
  });

  test("creates an empty remote, publishes a bundle, and downloads verified bytes", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    const destination = join(destinationDirectory, "restored.bundle");
    await writeFile(bundlePath, "known-good bundle");

    const store = new FilesystemRepositoryStore({
      rootDirectory,
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => "2026-08-23T12:00:00Z",
      writerId: "test-installation",
    });
    const empty = await store.create("my-repository");

    expect(empty.metadata).toMatchObject({ generation: 1, bundleFileId: null, refs: {} });
    const published = await store.publish(empty, bundlePath, {
      ...empty.metadata,
      bundleFileId: "pending-bundle",
      bundleSha256: sha256("known-good bundle"),
      refs: { "refs/heads/main": "0123456789abcdef0123456789abcdef01234567" },
      generation: 2,
    });

    await store.downloadBundle(published, destination);
    expect(await readFile(destination, "utf8")).toBe("known-good bundle");
    expect((await store.readDescriptor(empty.remoteId)).metadata).toEqual(published.metadata);
  });

  test("keeps the prior descriptor and bundle downloadable when publication is interrupted", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const firstBundle = join(sourceDirectory, "first.bundle");
    const secondBundle = join(sourceDirectory, "second.bundle");
    await writeFile(firstBundle, "first known-good bundle");
    await writeFile(secondBundle, "replacement bundle");
    const stableStore = new FilesystemRepositoryStore({
      rootDirectory,
      uuid: sequenceUuid(),
      now: () => "2026-08-23T12:00:00Z",
      writerId: "test-installation",
    });
    const empty = await stableStore.create("my-repository");
    const published = await stableStore.publish(empty, firstBundle, nextMetadata(empty, 2, sha256("first known-good bundle")));
    const interruptedStore = new FilesystemRepositoryStore({
      rootDirectory,
      uuid: sequenceUuid(),
      now: () => "2026-08-23T12:01:00Z",
      writerId: "test-installation",
      beforeMetadataPublication: () => {
        throw new Error("simulated bundle upload interruption");
      },
    });

    await expect(interruptedStore.publish(published, secondBundle, nextMetadata(published, 3, sha256("replacement bundle"))))
      .rejects.toThrow("simulated bundle upload interruption");
    expect(await stableStore.readDescriptor(empty.remoteId)).toEqual(published);
    await stableStore.downloadBundle(published, join(destinationDirectory, "restored.bundle"));
    expect(await readFile(join(destinationDirectory, "restored.bundle"), "utf8")).toBe("first known-good bundle");
  });

  test("maps missing remotes, missing bundles, corrupt bytes, and malformed metadata to stable errors", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundle = join(sourceDirectory, "repository.bundle");
    await writeFile(bundle, "known-good bundle");
    const store = new FilesystemRepositoryStore({ rootDirectory, uuid: sequenceUuid(), writerId: "test" });

    await expect(store.readDescriptor("repository-does-not-exist")).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
    const empty = await store.create("my-repository");
    await expect(store.downloadBundle(empty, join(destinationDirectory, "empty.bundle")))
      .rejects.toMatchObject({ code: "REMOTE_BUNDLE_MISSING" });
    const published = await store.publish(empty, bundle, nextMetadata(empty, 2, sha256("known-good bundle")));
    await expect(store.downloadBundle({
      ...published,
      metadata: { ...published.metadata, bundleSha256: "f".repeat(64) },
    }, join(destinationDirectory, "corrupt.bundle"))).rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
    await expect(readFile(join(destinationDirectory, "corrupt.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(rootDirectory, empty.remoteId, "repository.json"), "{ definitely not JSON");
    await expect(store.readDescriptor(empty.remoteId)).rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
  });

  test("detects a descriptor generation changed immediately after filesystem publication", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const stableStore = new FilesystemRepositoryStore({ rootDirectory, uuid: sequenceUuid(), writerId: "test" });
    const empty = await stableStore.create("my-repository");
    const published = await stableStore.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));
    const racingStore = new FilesystemRepositoryStore({
      rootDirectory,
      uuid: sequenceUuid(),
      writerId: "test",
      afterMetadataPublication: async () => {
        const changed = await stableStore.readDescriptor(empty.remoteId);
        await writeFile(join(rootDirectory, empty.remoteId, "repository.json"), serializeRepositoryMetadata({
          ...changed.metadata,
          generation: changed.metadata.generation + 1,
        }));
      },
    });

    await expect(racingStore.publish(published, bundlePath, nextMetadata(published, 3, sha256("known-good bundle"))))
      .rejects.toMatchObject({ code: "REMOTE_CHANGED_DURING_PUSH" });
  });

  test("publishes final-ref deletion as empty metadata while preserving the old filesystem bundle", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const store = new FilesystemRepositoryStore({ rootDirectory, uuid: sequenceUuid(), writerId: "test" });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));

    const deleted = await store.publish(published, null, emptyNextMetadata(published, 3));

    expect(deleted.metadata).toMatchObject({ generation: 3, bundleFileId: null, bundleSha256: null, refs: {} });
    await store.downloadBundle(published, join(destinationDirectory, "old.bundle"));
    expect(await readFile(join(destinationDirectory, "old.bundle"), "utf8")).toBe("known-good bundle");
  });

  test("rejects invalid filesystem bundle and ref combinations without changing the descriptor", async () => {
    const rootDirectory = await temporaryDirectory();
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const store = new FilesystemRepositoryStore({ rootDirectory, uuid: sequenceUuid(), writerId: "test" });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));

    await expect(store.publish(published, null, nextMetadata(published, 3, sha256("known-good bundle"))))
      .rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
    await expect(store.publish(published, bundlePath, emptyNextMetadata(published, 3)))
      .rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(published);
  });
});

describe("GoogleDriveRepositoryStore", () => {
  test("serializes a validated resource-key route into the Google request header", async () => {
    let receivedOptions: unknown;
    const externalClient = createGoogleDriveExternalClient({
      files: {
        get: async (input: unknown, options: unknown) => {
          expect(input).toMatchObject({ fileId: "folder-id" });
          receivedOptions = options;
          return { data: { id: "folder-id" } };
        },
      },
    } as unknown as drive_v3.Drive);

    await externalClient.getFile({
      fileId: "folder-id",
      routing: { folderId: "folder-id", resourceKey: "routing_key-123" },
    });

    expect(receivedOptions).toEqual({
      headers: { "X-Goog-Drive-Resource-Keys": "folder-id/routing_key-123" },
    });
  });

  test("rejects an unsafe resource key before contacting Drive", async () => {
    const drive = new TestDriveClient();
    drive.rejectAllExternalCalls();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test-installation" });

    await expect(store.readDescriptor("folder-id", "unsafe\nheader"))
      .rejects.toMatchObject({ code: "REMOTE_URL_INVALID" });
  });

  test("reads and publishes through a folder resource key", async () => {
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    const destination = join(destinationDirectory, "restored.bundle");
    await writeFile(bundlePath, "resource-key bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const created = await store.create("my-repository");
    drive.requireResourceKey(created.remoteId, "routing_key-123");

    const keyed = await store.readDescriptor(created.remoteId, "routing_key-123");
    const published = await store.publish(
      keyed,
      bundlePath,
      nextMetadata(keyed, 2, sha256("resource-key bundle")),
    );

    expect(keyed.resourceKey).toBe("routing_key-123");
    expect(published.resourceKey).toBe("routing_key-123");
    await store.downloadBundle(published, destination);
    expect(await readFile(destination, "utf8")).toBe("resource-key bundle");
  });

  test("creates and reads a remote with the default UUID generator", async () => {
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test-installation" });

    const created = await store.create("my-repository");

    expect(await store.readDescriptor(created.remoteId)).toEqual(created);
  });

  test("publishes managed metadata and a downloadable verified bundle", async () => {
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    const destination = join(destinationDirectory, "restored.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({
      drive,
      writerId: "test-installation",
      uuid: sequenceUuid(),
      now: () => "2026-08-23T12:00:00Z",
      sleep: async () => {},
      random: () => 0,
    });

    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));

    expect((await store.readDescriptor(empty.remoteId)).metadata).toEqual(published.metadata);
    await store.downloadBundle(published, destination);
    expect(await readFile(destination, "utf8")).toBe("known-good bundle");
  });

  test("leaves the old Drive descriptor discoverable when metadata publication fails", async () => {
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));
    drive.failNext("update", new Error("network interruption"));

    await expect(store.publish(published, bundlePath, nextMetadata(published, 3, sha256("known-good bundle"))))
      .rejects.toMatchObject({ code: "DRIVE_NETWORK_ERROR" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(published);
  });

  test("rejects corrupt uploaded-bundle read-back without replacing the old descriptor", async () => {
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));
    drive.corruptNextBundleReadback();

    await expect(store.publish(published, bundlePath, nextMetadata(published, 3, sha256("known-good bundle"))))
      .rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(published);
  });

  test("downloads only the managed bundle referenced by this remote", async () => {
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    const destination = join(destinationDirectory, "restored.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));

    await store.downloadBundle(published, destination);
    expect(await readFile(destination, "utf8")).toBe("known-good bundle");
    drive.mismatchNextBundleManagedProperties();
    await expect(store.downloadBundle(published, join(destinationDirectory, "unsafe.bundle")))
      .rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
  });

  test("publishes final-ref deletion without uploading a new Drive bundle", async () => {
    const sourceDirectory = await temporaryDirectory();
    const destinationDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));
    drive.rejectBundleUploads();

    const deleted = await store.publish(published, null, emptyNextMetadata(published, 3));

    expect(deleted.metadata).toMatchObject({ generation: 3, bundleFileId: null, bundleSha256: null, refs: {} });
    await store.downloadBundle(published, join(destinationDirectory, "old.bundle"));
    expect(await readFile(join(destinationDirectory, "old.bundle"), "utf8")).toBe("known-good bundle");
  });

  test("rejects invalid Drive bundle and ref combinations without changing the descriptor", async () => {
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));

    await expect(store.publish(published, null, nextMetadata(published, 3, sha256("known-good bundle"))))
      .rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
    await expect(store.publish(published, bundlePath, emptyNextMetadata(published, 3)))
      .rejects.toMatchObject({ code: "REMOTE_METADATA_INVALID" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(published);
  });

  test("keeps the old Drive descriptor when empty metadata publication fails", async () => {
    const sourceDirectory = await temporaryDirectory();
    const bundlePath = join(sourceDirectory, "repository.bundle");
    await writeFile(bundlePath, "known-good bundle");
    const drive = new TestDriveClient();
    const store = new GoogleDriveRepositoryStore({ drive, writerId: "test", uuid: sequenceUuid() });
    const empty = await store.create("my-repository");
    const published = await store.publish(empty, bundlePath, nextMetadata(empty, 2, sha256("known-good bundle")));
    drive.failNext("update", new Error("metadata interruption"));

    await expect(store.publish(published, null, emptyNextMetadata(published, 3)))
      .rejects.toMatchObject({ code: "DRIVE_NETWORK_ERROR" });
    expect(await store.readDescriptor(empty.remoteId)).toEqual(published);
  });

  test("retries rate-limited Drive calls and maps exhausted and permission failures", async () => {
    const drive = new TestDriveClient();
    const sleeps: number[] = [];
    const store = new GoogleDriveRepositoryStore({
      drive,
      writerId: "test-installation",
      uuid: sequenceUuid(),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
      maxRetries: 1,
    });
    const remote = await store.create("my-repository");
    drive.failNext("get", { response: { status: 429 } });
    await expect(store.readDescriptor(remote.remoteId)).resolves.toEqual(remote);
    expect(sleeps).toEqual([100]);
    drive.failNext("get", { response: { status: 403 }, config: { headers: { Authorization: "secret" } } });
    let permissionError: unknown;
    try {
      await store.readDescriptor(remote.remoteId);
    } catch (error) {
      permissionError = error;
    }
    expect(permissionError).toMatchObject({ code: "DRIVE_PERMISSION_DENIED" });
    expect((permissionError as Error).message).not.toContain("secret");
    expect((permissionError as Error).message).not.toContain("Authorization");
    drive.failNext("get", { response: { status: 429 } });
    drive.failNext("get", { response: { status: 429 } });
    await expect(store.readDescriptor(remote.remoteId)).rejects.toMatchObject({ code: "DRIVE_RATE_LIMITED" });
  });
});

function nextMetadata(
  remote: { readonly metadata: RepositoryMetadata },
  generation: number,
  checksum: string,
): RepositoryMetadata {
  return {
    ...remote.metadata,
    bundleFileId: "pending-bundle",
    bundleSha256: checksum,
    refs: { "refs/heads/main": "0123456789abcdef0123456789abcdef01234567" },
    generation,
  };
}

function emptyNextMetadata(remote: { readonly metadata: RepositoryMetadata }, generation: number): RepositoryMetadata {
  return {
    ...remote.metadata,
    bundleFileId: null,
    bundleSha256: null,
    refs: {},
    generation,
  };
}

function sequenceUuid(): () => string {
  let value = 0;
  return () => `123e4567-e89b-12d3-a456-426614174${String(value++).padStart(3, "0")}`;
}
