import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GitRepositoryEngine } from "../../src/git/git-repository-engine.js";
import { withGitFixture } from "../support/git-fixture.js";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-storage-bundle-output-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GitRepositoryEngine incremental artifacts", () => {
  test("creates a self-contained base artifact", async () => {
    await withGitFixture(async (fixture) => {
      const commit = await fixture.commit("readme.txt", "one\n", "initial");
      const output = join(await temporaryDirectory(), "base.bundle");
      const target = join(await temporaryDirectory(), "target.git");
      const engine = new GitRepositoryEngine();

      const result = await engine.buildIncrementalArtifact({
        currentRefs: {},
        hasRemoteArtifacts: false,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
      });
      await fixture.git(fixture.root, ["init", "--bare", target]);
      await engine.importArtifact(output, target);

      expect(result.refs).toEqual({ "refs/heads/main": commit });
      expect(result.artifact).toMatchObject({
        kind: "base",
        prerequisites: [],
        heads: { "refs/heads/main": commit },
      });
      expect(await engine.hasObject(target, commit)).toBe(true);
    });
  });

  test("creates a thin incremental artifact that applies after its base", async () => {
    await withGitFixture(async (fixture) => {
      const first = await fixture.commit("readme.txt", "one\n", "first");
      const engine = new GitRepositoryEngine();
      const basePath = join(await temporaryDirectory(), "base.bundle");
      await engine.buildIncrementalArtifact({
        currentRefs: {}, hasRemoteArtifacts: false, localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: basePath,
      });
      const second = await fixture.commit("readme.txt", "two\n", "second");
      const incrementalPath = join(await temporaryDirectory(), "incremental.bundle");
      const incremental = await engine.buildIncrementalArtifact({
        currentRefs: { "refs/heads/main": first },
        hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: incrementalPath,
      });
      const target = join(await temporaryDirectory(), "target.git");
      await fixture.git(fixture.root, ["init", "--bare", target]);
      await expect(engine.importArtifact(incrementalPath, target)).rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
      await engine.importArtifact(basePath, target);
      await engine.importArtifact(incrementalPath, target);

      expect(incremental.artifact).toMatchObject({
        kind: "incremental",
        prerequisites: [first],
        heads: { "refs/heads/main": second },
      });
      expect(await engine.hasObject(target, second)).toBe(true);
    });
  });

  test("preserves unrelated refs in metadata and emits only changed heads", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "main");
      await fixture.createBranch("feature", "main");
      await fixture.git(fixture.repository, ["switch", "feature"]);
      const feature = await fixture.commit("feature.txt", "feature\n", "feature");
      const result = await new GitRepositoryEngine().buildIncrementalArtifact({
        currentRefs: { "refs/heads/main": main },
        hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "feature", destination: "refs/heads/feature", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "feature.bundle"),
      });
      expect(result.refs).toEqual({ "refs/heads/main": main, "refs/heads/feature": feature });
      expect(result.artifact?.heads).toEqual({ "refs/heads/feature": feature });
    });
  });

  test("rejects non-fast-forward branches and unforced tag replacement", async () => {
    await withGitFixture(async (fixture) => {
      const base = await fixture.commit("readme.txt", "base\n", "base");
      const remote = await fixture.commit("readme.txt", "remote\n", "remote");
      await fixture.git(fixture.repository, ["switch", "-c", "divergent", base]);
      await fixture.commit("readme.txt", "divergent\n", "divergent");
      const engine = new GitRepositoryEngine();
      await expect(engine.buildIncrementalArtifact({
        currentRefs: { "refs/heads/main": remote }, hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "divergent", destination: "refs/heads/main", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "rejected.bundle"),
      })).rejects.toMatchObject({ code: "NON_FAST_FORWARD" });

      await fixture.git(fixture.repository, ["tag", "old", base]);
      await fixture.git(fixture.repository, ["tag", "new", "divergent"]);
      const oldTag = await fixture.objectId("old");
      await expect(engine.buildIncrementalArtifact({
        currentRefs: { "refs/tags/release": oldTag }, hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "new", destination: "refs/tags/release", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "tag.bundle"),
      })).rejects.toMatchObject({ code: "NON_FAST_FORWARD" });
    });
  });

  test("allows explicit force and creates a self-contained incremental when the old tip is unrelated", async () => {
    await withGitFixture(async (fixture) => {
      const base = await fixture.commit("readme.txt", "base\n", "base");
      const remote = await fixture.commit("readme.txt", "remote\n", "remote");
      await fixture.git(fixture.repository, ["switch", "-c", "divergent", base]);
      const divergent = await fixture.commit("readme.txt", "divergent\n", "divergent");
      const result = await new GitRepositoryEngine().buildIncrementalArtifact({
        currentRefs: { "refs/heads/main": remote }, hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "divergent", destination: "refs/heads/main", force: true }],
        outputBundlePath: join(await temporaryDirectory(), "forced.bundle"),
      });
      expect(result.refs).toEqual({ "refs/heads/main": divergent });
      expect(result.artifact?.prerequisites).toEqual([]);
    });
  });

  test("deletions change refs without creating an artifact", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "main");
      const result = await new GitRepositoryEngine().buildIncrementalArtifact({
        currentRefs: { "refs/heads/main": main }, hasRemoteArtifacts: true,
        localGitDir: fixture.repository,
        updates: [{ kind: "delete", source: null, destination: "refs/heads/main", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "unused.bundle"),
      });
      expect(result).toEqual({ artifact: null, refs: {} });
    });
  });

  test("rejects non-commit branch targets and corrupt artifacts", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "main");
      const blob = await fixture.git(fixture.repository, ["hash-object", "-w", "readme.txt"]);
      await expect(new GitRepositoryEngine().buildIncrementalArtifact({
        currentRefs: {}, hasRemoteArtifacts: false, localGitDir: fixture.repository,
        updates: [{ kind: "update", source: blob, destination: "refs/heads/main", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "invalid.bundle"),
      })).rejects.toMatchObject({ code: "INVALID_REF" });

      const corrupt = join(await temporaryDirectory(), "corrupt.bundle");
      const target = join(await temporaryDirectory(), "target.git");
      await writeFile(corrupt, "not a bundle");
      await fixture.git(fixture.root, ["init", "--bare", target]);
      await expect(new GitRepositoryEngine().importArtifact(corrupt, target))
        .rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
    });
  });

  test("cleans temporary repositories", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "main");
      const parent = await temporaryDirectory();
      await new GitRepositoryEngine().buildIncrementalArtifact({
        currentRefs: {}, hasRemoteArtifacts: false, localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "base.bundle"),
        temporaryDirectoryParent: parent,
      });
      expect(await readdir(parent)).toEqual([]);
    });
  });
});
