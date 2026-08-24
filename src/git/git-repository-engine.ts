import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { GitStorageError } from "../domain/errors.js";
import {
  type ObjectId,
  type PushRefspec,
  type RemoteRefName,
  validateObjectId,
  validateRemoteRef,
} from "../domain/refs.js";
import { GitProcess } from "./git-process.js";

export interface AdvertisedRef {
  readonly name: RemoteRefName;
  readonly objectId: ObjectId;
}

export interface AdvertisedRefs {
  readonly refs: readonly AdvertisedRef[];
}

export interface BuildBundleInput {
  readonly existingBundlePath: string | null;
  readonly localGitDir: string;
  readonly updates: readonly PushRefspec[];
  readonly outputBundlePath: string;
  readonly temporaryDirectoryParent?: string;
}

export interface BuildBundleResult {
  readonly bundlePath: string | null;
  readonly bundleSha256: string | null;
  readonly refs: Readonly<Record<RemoteRefName, ObjectId>>;
}

/** Deep Git seam: combines ref policy, bundle validation, and temporary-repository lifecycle. */
export class GitRepositoryEngine {
  constructor(private readonly git = new GitProcess()) {}

  async listRefs(bundlePath: string | null): Promise<AdvertisedRefs> {
    if (bundlePath === null) {
      return { refs: [] };
    }

    return this.withTemporaryBareRepository(undefined, async (gitDir) => {
      await this.importBundle(bundlePath, gitDir);
      return { refs: await this.bundleRefs(bundlePath, gitDir) };
    });
  }

  async importBundle(bundlePath: string, targetGitDir: string): Promise<void> {
    try {
      await this.git.run(["bundle", "verify", bundlePath], { cwd: targetGitDir });
      await this.git.run(["bundle", "unbundle", bundlePath], { cwd: targetGitDir });
      await this.git.run(["fsck", "--full"], { cwd: targetGitDir });
    } catch (error) {
      throw asCorruptBundle(error);
    }
  }

  async buildNextBundle(input: BuildBundleInput): Promise<BuildBundleResult> {
    return this.withTemporaryBareRepository(input.temporaryDirectoryParent, async (gitDir) => {
      if (input.existingBundlePath !== null) {
        await this.importBundle(input.existingBundlePath, gitDir);
        await this.hydrateBundleRefs(input.existingBundlePath, gitDir);
      }
      await this.applyUpdates(gitDir, input);
      const refs = await this.refsInRepository(gitDir);
      if (refs.length === 0) {
        return { bundlePath: null, bundleSha256: null, refs: {} };
      }

      const temporaryBundlePath = join(
        dirname(input.outputBundlePath),
        `.${basename(input.outputBundlePath)}.${randomUUID()}.tmp`,
      );
      try {
        await this.git.run(
          ["bundle", "create", temporaryBundlePath, ...refs.map((ref) => ref.name)],
          { cwd: gitDir },
        );
        await this.verifyBundle(temporaryBundlePath);
        const bundleSha256 = await sha256(temporaryBundlePath);
        await rename(temporaryBundlePath, input.outputBundlePath);
        return { bundlePath: input.outputBundlePath, bundleSha256, refs: toRefMap(refs) };
      } finally {
        await unlink(temporaryBundlePath).catch(() => undefined);
      }
    });
  }

  async verifyBundle(bundlePath: string): Promise<void> {
    await this.withTemporaryBareRepository(undefined, async (gitDir) => {
      await this.importBundle(bundlePath, gitDir);
    });
  }

  private async applyUpdates(gitDir: string, input: BuildBundleInput): Promise<void> {
    const destinations = new Set<string>();
    for (const update of input.updates) {
      const destination = validateRemoteRef(update.destination);
      if (destinations.has(destination)) {
        throw invalidRef();
      }
      destinations.add(destination);

      if (update.kind === "delete") {
        await this.git.run(["update-ref", "-d", destination], { cwd: gitDir });
        continue;
      }
      if (update.source === null) {
        throw invalidRef();
      }

      const sourceObjectId = await this.resolveSourceObject(input.localGitDir, update.source);
      await this.fetchSourceObject(gitDir, input.localGitDir, sourceObjectId);
      const objectType = await this.objectType(gitDir, sourceObjectId);
      if (destination.startsWith("refs/heads/") && objectType !== "commit") {
        throw invalidRef();
      }

      const currentObjectId = await this.refObjectId(gitDir, destination);
      if (
        destination.startsWith("refs/heads/") &&
        currentObjectId !== null &&
        update.force === false &&
        !(await this.isAncestor(gitDir, currentObjectId, sourceObjectId))
      ) {
        throw new GitStorageError("NON_FAST_FORWARD", `Non-fast-forward update rejected for ${destination}.`);
      }
      await this.git.run(["update-ref", destination, sourceObjectId], { cwd: gitDir });
    }

    await this.git.run(["for-each-ref", "--format=%(refname)", "refs/gdrive-staging/"], { cwd: gitDir })
      .then(async (result) => Promise.all(
        result.stdout.split("\n").filter(Boolean).map((refname) =>
          this.git.run(["update-ref", "-d", refname], { cwd: gitDir }),
        ),
      ));
  }

  private async resolveSourceObject(localGitDir: string, source: string): Promise<ObjectId> {
    if (source.length === 0 || /[\r\n\0]/.test(source)) {
      throw invalidRef();
    }
    const result = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `${source}^{object}`],
      { cwd: localGitDir, allowFailure: true },
    );
    if (result.exitCode !== 0) {
      throw invalidRef();
    }
    try {
      return validateObjectId(result.stdout.trim());
    } catch {
      throw invalidRef();
    }
  }

  private async fetchSourceObject(gitDir: string, localGitDir: string, objectId: ObjectId): Promise<void> {
    const stagingRef = `refs/gdrive-staging/${randomUUID()}`;
    await this.git.run(
      ["fetch", "--no-tags", "--force", localGitDir, `${objectId}:${stagingRef}`],
      { cwd: gitDir },
    );
  }

  private async objectType(gitDir: string, objectId: ObjectId): Promise<string> {
    const result = await this.git.run(["cat-file", "-t", objectId], { cwd: gitDir });
    return result.stdout.trim();
  }

  private async refObjectId(gitDir: string, refname: RemoteRefName): Promise<ObjectId | null> {
    const result = await this.git.run(["rev-parse", "--verify", refname], {
      cwd: gitDir,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return validateObjectId(result.stdout.trim());
  }

  private async isAncestor(gitDir: string, older: ObjectId, newer: ObjectId): Promise<boolean> {
    const result = await this.git.run(["merge-base", "--is-ancestor", older, newer], {
      cwd: gitDir,
      allowFailure: true,
    });
    return result.exitCode === 0;
  }

  private async refsInRepository(gitDir: string): Promise<AdvertisedRef[]> {
    const result = await this.git.run(
      ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/tags/"],
      { cwd: gitDir },
    );
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(" ");
        return {
          objectId: validateObjectId(line.slice(0, separator)),
          name: validateRemoteRef(line.slice(separator + 1)),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async hydrateBundleRefs(bundlePath: string, gitDir: string): Promise<void> {
    for (const ref of await this.bundleRefs(bundlePath, gitDir)) {
      await this.git.run(["update-ref", ref.name, ref.objectId], { cwd: gitDir });
    }
  }

  private async bundleRefs(bundlePath: string, gitDir: string): Promise<AdvertisedRef[]> {
    const result = await this.git.run(["bundle", "list-heads", bundlePath], { cwd: gitDir });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(" ");
        if (separator < 1) {
          throw asCorruptBundle(new Error("Bundle ref listing was malformed."));
        }
        return {
          objectId: validateObjectId(line.slice(0, separator)),
          name: validateRemoteRef(line.slice(separator + 1)),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async withTemporaryBareRepository<T>(
    parentDirectory: string | undefined,
    action: (gitDir: string) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(join(parentDirectory ?? tmpdir(), "git-storage-bundle-"));
    const gitDir = join(root, "repository.git");
    try {
      await this.git.run(["init", "--bare", gitDir], { cwd: root });
      return await action(gitDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function toRefMap(refs: readonly AdvertisedRef[]): Readonly<Record<RemoteRefName, ObjectId>> {
  return Object.fromEntries(refs.map((ref) => [ref.name, ref.objectId])) as Readonly<
    Record<RemoteRefName, ObjectId>
  >;
}

async function sha256(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function asCorruptBundle(error: unknown): GitStorageError {
  if (error instanceof GitStorageError && error.code === "GIT_NOT_FOUND") {
    return error;
  }
  return new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The remote Git bundle is corrupt or incomplete.", {
    cause: error,
  });
}

function invalidRef(): GitStorageError {
  return new GitStorageError("INVALID_REF", "Invalid remote reference.");
}
