import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

describe("GitRepositoryEngine", () => {
  test("creates a complete one-commit bundle and imports its objects without mutating target refs", async () => {
    await withGitFixture(async (fixture) => {
      const commit = await fixture.commit("readme.txt", "one\n", "initial commit");
      const output = join(await temporaryDirectory(), "repository.bundle");
      const destination = join(await temporaryDirectory(), "restored.git");
      const engine = new GitRepositoryEngine();

      const result = await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "refs/heads/main", destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
      });
      await fixture.git(fixture.root, ["init", "--bare", destination]);
      await engine.importBundle(output, destination);

      expect(result.refs).toEqual({ "refs/heads/main": commit });
      await expect(fixture.git(destination, ["cat-file", "-e", `${commit}^{commit}`])).resolves.toBe("");
      expect(await fixture.git(destination, ["cat-file", "-t", commit])).toBe("commit");
      expect(await fixture.git(destination, ["for-each-ref", "--format=%(refname)"])).toBe("");
      await expect(fixture.git(destination, ["fsck", "--full"])).resolves.toContain("dangling commit");
    });
  });

  test("lists the main ref for HEAD advertisement after building a bundle", async () => {
    await withGitFixture(async (fixture) => {
      const commit = await fixture.commit("readme.txt", "one\n", "initial commit");
      const output = join(await temporaryDirectory(), "repository.bundle");
      const engine = new GitRepositoryEngine();

      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "refs/heads/main", destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
      });

      await expect(engine.listRefs(output)).resolves.toEqual({
        refs: [{ name: "refs/heads/main", objectId: commit }],
      });
    });
  });

  test("preserves an existing branch while adding another branch", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const replacementBundle = join(await temporaryDirectory(), "replacement.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "refs/heads/main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });
      await fixture.createBranch("feature", "main");
      await fixture.git(fixture.repository, ["switch", "feature"]);
      const feature = await fixture.commit("feature.txt", "feature\n", "feature commit");

      const result = await engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "refs/heads/feature", destination: "refs/heads/feature", force: false }],
        outputBundlePath: replacementBundle,
      });

      expect(result.refs).toEqual({ "refs/heads/feature": feature, "refs/heads/main": main });
      await expect(engine.listRefs(replacementBundle)).resolves.toEqual({
        refs: [
          { name: "refs/heads/feature", objectId: feature },
          { name: "refs/heads/main", objectId: main },
        ],
      });
    });
  });

  test("preserves annotated and lightweight tags as their Git object types", async () => {
    await withGitFixture(async (fixture) => {
      const commit = await fixture.commit("readme.txt", "one\n", "initial commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const replacementBundle = join(await temporaryDirectory(), "replacement.bundle");
      const destination = join(await temporaryDirectory(), "restored.git");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });
      await fixture.git(fixture.repository, ["tag", "-a", "v1.0.0", "-m", "annotated", "main"]);
      await fixture.git(fixture.repository, ["tag", "latest", "main"]);
      const annotatedTag = await fixture.objectId("v1.0.0");
      const lightweightTag = await fixture.objectId("latest");

      const result = await engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [
          { kind: "update", source: "v1.0.0", destination: "refs/tags/v1.0.0", force: false },
          { kind: "update", source: "latest", destination: "refs/tags/latest", force: false },
        ],
        outputBundlePath: replacementBundle,
      });
      await fixture.git(fixture.root, ["init", "--bare", destination]);
      await engine.importBundle(replacementBundle, destination);

      expect(result.refs).toEqual({
        "refs/heads/main": commit,
        "refs/tags/latest": lightweightTag,
        "refs/tags/v1.0.0": annotatedTag,
      });
      expect(await fixture.git(destination, ["cat-file", "-t", annotatedTag])).toBe("tag");
      expect(await fixture.git(destination, ["cat-file", "-t", lightweightTag])).toBe("commit");
      expect(await fixture.git(destination, ["for-each-ref", "--format=%(refname)"])).toBe("");
      await expect(fixture.git(destination, ["fsck", "--full"])).resolves.toContain("dangling");
    });
  });

  test("updates a branch with a fast-forward commit", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const replacementBundle = join(await temporaryDirectory(), "replacement.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });
      const nextCommit = await fixture.commit("readme.txt", "two\n", "fast-forward commit");

      const result = await engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: replacementBundle,
      });

      expect(result.refs).toEqual({ "refs/heads/main": nextCommit });
      await expect(engine.listRefs(replacementBundle)).resolves.toEqual({
        refs: [{ name: "refs/heads/main", objectId: nextCommit }],
      });
    });
  });

  test("rejects a non-fast-forward branch update unless force is explicit", async () => {
    await withGitFixture(async (fixture) => {
      const initial = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.commit("readme.txt", "remote\n", "remote commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const rejectedBundle = join(await temporaryDirectory(), "rejected.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });
      await fixture.git(fixture.repository, ["switch", "-c", "divergent", initial]);
      await fixture.commit("readme.txt", "other\n", "divergent commit");

      await expect(engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "divergent", destination: "refs/heads/main", force: false }],
        outputBundlePath: rejectedBundle,
      })).rejects.toMatchObject({ code: "NON_FAST_FORWARD" });
    });
  });

  test("accepts the same non-fast-forward branch update when force is explicit", async () => {
    await withGitFixture(async (fixture) => {
      const initial = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.commit("readme.txt", "remote\n", "remote commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const replacementBundle = join(await temporaryDirectory(), "replacement.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });
      await fixture.git(fixture.repository, ["switch", "-c", "divergent", initial]);
      const divergent = await fixture.commit("readme.txt", "other\n", "divergent commit");

      const result = await engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "divergent", destination: "refs/heads/main", force: true }],
        outputBundlePath: replacementBundle,
      });

      expect(result.refs).toEqual({ "refs/heads/main": divergent });
    });
  });

  test("deletes a branch while preserving unrelated refs", async () => {
    await withGitFixture(async (fixture) => {
      const main = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.createBranch("obsolete", "main");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const replacementBundle = join(await temporaryDirectory(), "replacement.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [
          { kind: "update", source: "main", destination: "refs/heads/main", force: false },
          { kind: "update", source: "obsolete", destination: "refs/heads/obsolete", force: false },
        ],
        outputBundlePath: initialBundle,
      });

      const result = await engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "delete", source: null, destination: "refs/heads/obsolete", force: false }],
        outputBundlePath: replacementBundle,
      });

      expect(result.refs).toEqual({ "refs/heads/main": main });
    });
  });

  test("returns an explicit empty result after deleting the final ref", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const initialBundle = join(await temporaryDirectory(), "initial.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: initialBundle,
      });

      await expect(engine.buildNextBundle({
        existingBundlePath: initialBundle,
        localGitDir: fixture.repository,
        updates: [{ kind: "delete", source: null, destination: "refs/heads/main", force: false }],
        outputBundlePath: join(await temporaryDirectory(), "unused.bundle"),
      })).resolves.toEqual({ bundlePath: null, bundleSha256: null, refs: {} });
    });
  });

  test("rejects a tree proposed as a branch target without replacing an existing output", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const output = join(await temporaryDirectory(), "repository.bundle");
      const engine = new GitRepositoryEngine();
      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
      });
      const before = await readFile(output);
      const tree = await fixture.git(fixture.repository, ["write-tree"]);

      await expect(engine.buildNextBundle({
        existingBundlePath: output,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: tree, destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
      })).rejects.toMatchObject({ code: "INVALID_REF" });
      expect(await readFile(output)).toEqual(before);
    });
  });

  test("rejects blob and tag objects proposed as branch targets", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.git(fixture.repository, ["tag", "-a", "v1.0.0", "-m", "annotated", "main"]);
      const blob = await fixture.git(fixture.repository, ["hash-object", "-w", "readme.txt"]);
      const output = join(await temporaryDirectory(), "repository.bundle");
      const engine = new GitRepositoryEngine();

      for (const source of [blob, "v1.0.0"]) {
        await expect(engine.buildNextBundle({
          existingBundlePath: null,
          localGitDir: fixture.repository,
          updates: [{ kind: "update", source, destination: "refs/heads/main", force: false }],
          outputBundlePath: output,
        })).rejects.toMatchObject({ code: "INVALID_REF" });
      }
    });
  });

  test("rejects a corrupt bundle with the stable corruption error", async () => {
    const corruptBundle = join(await temporaryDirectory(), "corrupt.bundle");
    await writeFile(corruptBundle, "not a Git bundle");
    await expect(new GitRepositoryEngine().verifyBundle(corruptBundle)).rejects.toMatchObject({
      code: "REMOTE_BUNDLE_CORRUPT",
    });
  });

  test("rejects a disconnected incremental bundle with the stable corruption error", async () => {
    await withGitFixture(async (fixture) => {
      const prerequisite = await fixture.commit("readme.txt", "one\n", "initial commit");
      await fixture.commit("readme.txt", "two\n", "incremental commit");
      const disconnectedBundle = join(await temporaryDirectory(), "incremental.bundle");
      await fixture.git(fixture.repository, ["bundle", "create", disconnectedBundle, "main", `^${prerequisite}`]);

      await expect(new GitRepositoryEngine().verifyBundle(disconnectedBundle)).rejects.toMatchObject({
        code: "REMOTE_BUNDLE_CORRUPT",
      });
    });
  });

  test("cleans its owned temporary bare repositories after success and failure", async () => {
    await withGitFixture(async (fixture) => {
      await fixture.commit("readme.txt", "one\n", "initial commit");
      const temporaryParent = await temporaryDirectory();
      const output = join(await temporaryDirectory(), "repository.bundle");
      const engine = new GitRepositoryEngine();

      await engine.buildNextBundle({
        existingBundlePath: null,
        localGitDir: fixture.repository,
        updates: [{ kind: "update", source: "main", destination: "refs/heads/main", force: false }],
        outputBundlePath: output,
        temporaryDirectoryParent: temporaryParent,
      });
      await expect(engine.buildNextBundle({
        existingBundlePath: join(temporaryParent, "missing.bundle"),
        localGitDir: fixture.repository,
        updates: [],
        outputBundlePath: output,
        temporaryDirectoryParent: temporaryParent,
      })).rejects.toMatchObject({ code: "REMOTE_BUNDLE_CORRUPT" });
      await expect(readdir(temporaryParent)).resolves.toEqual([]);
    });
  });
});
