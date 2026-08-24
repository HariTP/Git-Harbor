import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GitStorageApplication } from "../../src/application/git-storage-application.js";
import type { RepositoryMetadata } from "../../src/domain/metadata.js";
import { GitRepositoryEngine } from "../../src/git/git-repository-engine.js";
import { FilesystemRepositoryStore } from "../../src/storage/filesystem-repository-store.js";
import type { RemoteDescriptor, RepositoryStore } from "../../src/storage/repository-store.js";
import { withGitFixture } from "../support/git-fixture.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-storage-application-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GitStorageApplication", () => {
  test("creates an empty remote through the application seam", async () => {
    const store = new FilesystemRepositoryStore({
      rootDirectory: await temporaryDirectory(),
      writerId: "test",
      uuid: sequenceUuid(),
    });
    const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });

    const remote = await application.createRemote("my-repository");

    expect(remote.metadata).toMatchObject({
      displayName: "my-repository",
      generation: 1,
      bundleFileId: null,
      bundleSha256: null,
      refs: {},
    });
    expect(await store.readDescriptor(remote.remoteId)).toEqual(remote);
  });

  test("lists an empty remote with its configured default branch", async () => {
    const store = new FilesystemRepositoryStore({
      rootDirectory: await temporaryDirectory(),
      writerId: "test",
      uuid: sequenceUuid(),
    });
    const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
    const remote = await application.createRemote("my-repository");

    await expect(application.listRemote(remote.remoteId)).resolves.toEqual({
      defaultBranch: "refs/heads/main",
      refs: [],
    });
  });

  test("routes the resource key through list, push, and fetch without persisting it", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      const destination = join(await temporaryDirectory(), "restored.git");
      const baseStore = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const store = new RecordingRepositoryStore(baseStore);
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");

      await expect(application.listRemote(remote.remoteId, "routing-key-123")).resolves.toEqual({
        defaultBranch: "refs/heads/main",
        refs: [],
      });
      await application.push({
        remoteId: remote.remoteId,
        resourceKey: "routing-key-123",
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });
      await fixture.git(fixture.root, ["init", "--bare", destination]);
      await application.fetch({
        remoteId: remote.remoteId,
        resourceKey: "routing-key-123",
        targetGitDir: destination,
      });

      expect(store.descriptorReads).toEqual([
        { remoteId: remote.remoteId, resourceKey: "routing-key-123" },
        { remoteId: remote.remoteId, resourceKey: "routing-key-123" },
        { remoteId: remote.remoteId, resourceKey: "routing-key-123" },
      ]);
      await expect(fixture.git(destination, ["cat-file", "-e", `${main}^{commit}`])).resolves.toBe("");
      const persisted = await baseStore.readDescriptor(remote.remoteId);
      expect(persisted).not.toHaveProperty("resourceKey");
      expect(persisted.metadata).not.toHaveProperty("resourceKey");
    });
  });

  test("publishes the first branch as a verified remote bundle", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      const temporaryDirectoryParent = await temporaryDirectory();
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        temporaryDirectoryParent,
      })).resolves.toEqual([{ destination: "refs/heads/main", ok: true }]);

      const published = await store.readDescriptor(remote.remoteId);
      expect(published.metadata).toMatchObject({
        generation: 2,
        refs: { "refs/heads/main": main },
      });
      expect(published.metadata.bundleFileId).not.toBeNull();
      expect(published.metadata.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
      await expect(application.listRemote(remote.remoteId)).resolves.toEqual({
        defaultBranch: "refs/heads/main",
        refs: [{ name: "refs/heads/main", objectId: main }],
      });
      expect(await readdir(temporaryDirectoryParent)).toEqual([]);
    });
  });

  test("uses the first published branch as the advertised default", async () => {
    await withGitFixture(async (fixture) => {
      const trunk = await fixture.commit("readme.txt", "one\n", "initial commit");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");

      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/trunk", force: false }],
      });

      expect((await store.readDescriptor(remote.remoteId)).metadata.defaultBranch).toBe("refs/heads/trunk");
      await expect(application.listRemote(remote.remoteId)).resolves.toEqual({
        defaultBranch: "refs/heads/trunk",
        refs: [{ name: "refs/heads/trunk", objectId: trunk }],
      });
    });
  });

  test("selects the lexicographically first remaining branch when deleting the default", async () => {
    await withGitFixture(async (fixture) => {
      const commit = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.createBranch("zeta", "main");
      await fixture.createBranch("alpha", "main");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [
          { kind: "update", source: "main", destination: "refs/heads/main", force: false },
          { kind: "update", source: "zeta", destination: "refs/heads/zeta", force: false },
          { kind: "update", source: "alpha", destination: "refs/heads/alpha", force: false },
        ],
      });

      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "delete", source: null, destination: "refs/heads/main", force: false }],
      });

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        defaultBranch: "refs/heads/alpha",
        refs: {
          "refs/heads/alpha": commit,
          "refs/heads/zeta": commit,
        },
      });
      expect((await application.listRemote(remote.remoteId)).defaultBranch).toBe("refs/heads/alpha");
    });
  });

  test("imports a published bundle into a new repository without changing its refs", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      const temporaryDirectoryParent = await temporaryDirectory();
      const destination = join(await temporaryDirectory(), "restored.git");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });
      await fixture.git(fixture.root, ["init", "--bare", destination]);

      await application.fetch({ remoteId: remote.remoteId, targetGitDir: destination, temporaryDirectoryParent });

      await expect(fixture.git(destination, ["cat-file", "-e", `${main}^{commit}`])).resolves.toBe("");
      expect(await fixture.git(destination, ["for-each-ref", "--format=%(refname)"])).toBe("");
      expect(await readdir(temporaryDirectoryParent)).toEqual([]);
    });
  });

  test("publishes a subsequent fast-forward update", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      const update = { kind: "update" as const, source: "main", destination: "refs/heads/main", force: false };
      await application.push({ remoteId: remote.remoteId, localGitDir: fixture.repository, updates: [update] });
      const next = await fixture.commit("readme.txt", "two\n", "fast-forward commit");

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [update],
      })).resolves.toEqual([{ destination: "refs/heads/main", ok: true }]);

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        generation: 3,
        refs: { "refs/heads/main": next },
      });
    });
  });

  test("preserves unrelated remote refs while publishing an update", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.createBranch("feature", "main");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [
          { kind: "update", source: "main", destination: "refs/heads/main", force: false },
          { kind: "update", source: "feature", destination: "refs/heads/feature", force: false },
        ],
      });
      const next = await fixture.commit("readme.txt", "two\n", "main update");

      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });

      expect((await store.readDescriptor(remote.remoteId)).metadata.refs).toEqual({
        "refs/heads/feature": main,
        "refs/heads/main": next,
      });
    });
  });

  test("returns deterministic per-ref errors without publishing a rejected batch", async () => {
    await withGitFixture(async (fixture) => {
      const initial = await fixture.commit("readme.txt", "one\n", "initial commit");
      const temporaryDirectoryParent = await temporaryDirectory();
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });
      const remoteMain = await fixture.commit("readme.txt", "remote\n", "remote commit");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });
      await fixture.git(fixture.repository, ["switch", "-c", "divergent", initial]);
      await fixture.commit("readme.txt", "other\n", "divergent commit");

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [
          { kind: "update", source: "divergent", destination: "refs/heads/main", force: false },
          { kind: "update", source: "divergent", destination: "refs/heads/other", force: false },
        ],
        temporaryDirectoryParent,
      })).resolves.toEqual([
        { destination: "refs/heads/main", ok: false, reason: "NON_FAST_FORWARD" },
        { destination: "refs/heads/other", ok: false, reason: "NON_FAST_FORWARD" },
      ]);

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        generation: 3,
        refs: { "refs/heads/main": remoteMain },
      });
      expect(await readdir(temporaryDirectoryParent)).toEqual([]);
    });
  });

  test("publishes final-ref deletion as an empty remote", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "delete", source: null, destination: "refs/heads/main", force: false }],
      })).resolves.toEqual([{ destination: "refs/heads/main", ok: true }]);

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        generation: 3,
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
      });
      await expect(application.listRemote(remote.remoteId)).resolves.toEqual({
        defaultBranch: "refs/heads/main",
        refs: [],
      });
    });
  });

  test("returns INVALID_REF results for an invalid batch without publishing it", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");
      await application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      });

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "not-a-local-ref", destination: "refs/heads/main", force: false }],
      })).resolves.toEqual([{ destination: "refs/heads/main", ok: false, reason: "INVALID_REF" }]);

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        generation: 2,
        refs: { "refs/heads/main": main },
      });
    });
  });

  test("preserves fatal storage errors without leaking them into push results", async () => {
    const store = new FilesystemRepositoryStore({
      rootDirectory: await temporaryDirectory(),
      writerId: "test",
      uuid: sequenceUuid(),
    });
    const application = new GitStorageApplication({ store, git: new GitRepositoryEngine() });

    await expect(application.fetch({
      remoteId: "repository-does-not-exist",
      targetGitDir: await temporaryDirectory(),
    })).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
  });

  test("detects a changed generation before publishing the replacement bundle", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const store = new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      });
      const racingStore = new GenerationRaceStore(store);
      const application = new GitStorageApplication({ store: racingStore, git: new GitRepositoryEngine() });
      const remote = await application.createRemote("my-repository");

      await expect(application.push({
        remoteId: remote.remoteId,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
      })).rejects.toMatchObject({ code: "REMOTE_CHANGED_DURING_PUSH" });

      expect((await store.readDescriptor(remote.remoteId)).metadata).toMatchObject({
        generation: 2,
        bundleFileId: null,
        refs: {},
      });
    });
  });

  test("aggregates read-only required and optional doctor checks", async () => {
    const application = new GitStorageApplication({
      store: new FilesystemRepositoryStore({
        rootDirectory: await temporaryDirectory(),
        writerId: "test",
        uuid: sequenceUuid(),
      }),
      git: new GitRepositoryEngine(),
      doctorChecks: [
        { name: "git", required: true, check: async () => {} },
        { name: "drive", required: false, check: async () => { throw new Error("unavailable"); } },
      ],
    });

    await expect(application.doctor()).resolves.toEqual({
      ok: true,
      checks: [
        { name: "git", required: true, ok: true },
        { name: "drive", required: false, ok: false, message: "check failed" },
      ],
    });
  });
});

function sequenceUuid(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

class RecordingRepositoryStore implements RepositoryStore {
  readonly descriptorReads: Array<{ readonly remoteId: string; readonly resourceKey?: string }> = [];

  constructor(private readonly store: RepositoryStore) {}

  create(displayName: string): Promise<RemoteDescriptor> {
    return this.store.create(displayName);
  }

  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    this.descriptorReads.push({ remoteId, resourceKey });
    return this.store.readDescriptor(remoteId, resourceKey);
  }

  downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void> {
    return this.store.downloadBundle(remote, destination);
  }

  publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor> {
    return this.store.publish(remote, bundlePath, nextMetadata);
  }
}

class GenerationRaceStore implements RepositoryStore {
  private raced = false;

  constructor(private readonly store: RepositoryStore) {}

  create(displayName: string): Promise<RemoteDescriptor> {
    return this.store.create(displayName);
  }

  async readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor> {
    const descriptor = await this.store.readDescriptor(remoteId, resourceKey);
    if (!this.raced) {
      this.raced = true;
      await this.store.publish(descriptor, null, changedMetadata(descriptor.metadata));
    }
    return descriptor;
  }

  downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void> {
    return this.store.downloadBundle(remote, destination);
  }

  publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor> {
    return this.store.publish(remote, bundlePath, nextMetadata);
  }
}

function changedMetadata(metadata: RepositoryMetadata): RepositoryMetadata {
  return { ...metadata, generation: metadata.generation + 1 };
}
