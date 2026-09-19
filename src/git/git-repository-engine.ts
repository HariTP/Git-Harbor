import { createHash, randomUUID } from "node:crypto";
import { open, mkdtemp, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { GitStorageError } from "../domain/errors.js";
import type { ArtifactKind } from "../domain/metadata.js";
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

export interface BuildIncrementalArtifactInput {
  readonly currentRefs: Readonly<Record<string, string>>;
  readonly hasRemoteArtifacts: boolean;
  readonly localGitDir: string;
  readonly updates: readonly PushRefspec[];
  readonly outputBundlePath: string;
  readonly temporaryDirectoryParent?: string;
}

export interface BuiltArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly size: number;
  readonly prerequisites: readonly ObjectId[];
  readonly heads: Readonly<Record<RemoteRefName, ObjectId>>;
}

export interface BuildIncrementalArtifactResult {
  readonly artifact: BuiltArtifact | null;
  readonly refs: Readonly<Record<RemoteRefName, ObjectId>>;
}

/** Deep Git seam: owns ref policy, bundle construction, validation, and import. */
export class GitRepositoryEngine {
  constructor(private readonly git = new GitProcess()) {}

  async importArtifact(bundlePath: string, targetGitDir: string): Promise<void> {
    try {
      await this.git.run(["bundle", "verify", bundlePath], { cwd: targetGitDir });
      await this.git.run(["bundle", "unbundle", bundlePath], { cwd: targetGitDir });
      await this.git.run(["fsck", "--connectivity-only"], { cwd: targetGitDir });
    } catch (error) {
      throw asCorruptBundle(error);
    }
  }

  async hasObject(gitDir: string, objectId: string): Promise<boolean> {
    const validated = validateObjectId(objectId);
    const result = await this.git.run(["cat-file", "-e", `${validated}^{object}`], {
      cwd: gitDir,
      allowFailure: true,
    });
    return result.exitCode === 0;
  }

  async buildIncrementalArtifact(
    input: BuildIncrementalArtifactInput,
  ): Promise<BuildIncrementalArtifactResult> {
    const currentRefs = validateRefMap(input.currentRefs);
    const currentTips = new Set(Object.values(currentRefs));
    const nextRefs: Record<RemoteRefName, ObjectId> = { ...currentRefs };
    const changedHeads = new Map<RemoteRefName, ObjectId>();
    const destinations = new Set<string>();

    for (const update of input.updates) {
      const destination = validateRemoteRef(update.destination);
      if (destinations.has(destination)) throw invalidRef();
      destinations.add(destination);

      if (update.kind === "delete") {
        delete nextRefs[destination];
        continue;
      }
      if (update.source === null) throw invalidRef();

      const nextObjectId = await this.resolveSourceObject(input.localGitDir, update.source);
      const objectType = await this.objectType(input.localGitDir, nextObjectId);
      if (destination.startsWith("refs/heads/") && objectType !== "commit") throw invalidRef();

      const currentObjectId = currentRefs[destination] ?? null;
      if (currentObjectId !== null && currentObjectId !== nextObjectId && update.force === false) {
        if (destination.startsWith("refs/tags/")) {
          throw new GitStorageError("NON_FAST_FORWARD", `Tag update requires force for ${destination}.`);
        }
        if (!(await this.hasObject(input.localGitDir, currentObjectId)) ||
          !(await this.isAncestor(input.localGitDir, currentObjectId, nextObjectId))) {
          throw new GitStorageError(
            "NON_FAST_FORWARD",
            `Non-fast-forward update rejected for ${destination}; fetch the remote first.`,
          );
        }
      }

      nextRefs[destination] = nextObjectId;
      if (currentObjectId !== nextObjectId && !currentTips.has(nextObjectId)) {
        changedHeads.set(destination, nextObjectId);
      }
    }

    if (changedHeads.size === 0) {
      return { artifact: null, refs: nextRefs };
    }

    return this.withTemporaryBareRepository(input.temporaryDirectoryParent, async (gitDir) => {
      for (const [destination, objectId] of changedHeads) {
        await this.git.run(
          ["fetch", "--no-tags", "--force", input.localGitDir, `${objectId}:${destination}`],
          { cwd: gitDir },
        );
      }

      const availablePrerequisites: ObjectId[] = [];
      for (const objectId of new Set(Object.values(currentRefs))) {
        if (await this.hasObject(gitDir, objectId)) availablePrerequisites.push(objectId);
      }

      const temporaryBundlePath = join(
        dirname(input.outputBundlePath),
        `.${basename(input.outputBundlePath)}.${randomUUID()}.tmp`,
      );
      try {
        await this.git.run(
          [
            "bundle", "create", "--version=2", temporaryBundlePath,
            ...changedHeads.keys(),
            ...availablePrerequisites.map((oid) => `^${oid}`),
          ],
          { cwd: gitDir },
        );
        await this.git.run(["bundle", "verify", temporaryBundlePath], { cwd: input.localGitDir });
        const header = await readBundleHeader(temporaryBundlePath);
        const bundleSha256 = await sha256(temporaryBundlePath);
        const bundleSize = (await stat(temporaryBundlePath)).size;
        await rename(temporaryBundlePath, input.outputBundlePath);
        return {
          artifact: {
            path: input.outputBundlePath,
            kind: input.hasRemoteArtifacts ? "incremental" : "base",
            sha256: bundleSha256,
            size: bundleSize,
            prerequisites: header.prerequisites,
            heads: header.heads,
          },
          refs: nextRefs,
        };
      } finally {
        await unlink(temporaryBundlePath).catch(() => undefined);
      }
    });
  }

  private async resolveSourceObject(localGitDir: string, source: string): Promise<ObjectId> {
    if (source.length === 0 || /[\r\n\0]/.test(source)) throw invalidRef();
    const result = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `${source}^{object}`],
      { cwd: localGitDir, allowFailure: true },
    );
    if (result.exitCode !== 0) throw invalidRef();
    return validateObjectId(result.stdout.trim());
  }

  private async objectType(gitDir: string, objectId: ObjectId): Promise<string> {
    const result = await this.git.run(["cat-file", "-t", objectId], { cwd: gitDir });
    return result.stdout.trim();
  }

  private async isAncestor(gitDir: string, older: ObjectId, newer: ObjectId): Promise<boolean> {
    const result = await this.git.run(["merge-base", "--is-ancestor", older, newer], {
      cwd: gitDir,
      allowFailure: true,
    });
    return result.exitCode === 0;
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

function validateRefMap(value: Readonly<Record<string, string>>): Record<RemoteRefName, ObjectId> {
  return Object.fromEntries(
    Object.entries(value).map(([name, oid]) => [validateRemoteRef(name), validateObjectId(oid)]),
  ) as Record<RemoteRefName, ObjectId>;
}

async function readBundleHeader(path: string): Promise<{
  prerequisites: readonly ObjectId[];
  heads: Readonly<Record<RemoteRefName, ObjectId>>;
}> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < 4 * 1024 * 1024) {
      const chunk = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      const combined = Buffer.concat(chunks);
      const end = combined.indexOf("\n\n");
      if (end >= 0) return parseBundleHeader(combined.subarray(0, end).toString("utf8"));
    }
  } finally {
    await handle.close();
  }
  throw asCorruptBundle(new Error("Bundle header was missing or too large."));
}

function parseBundleHeader(text: string): {
  prerequisites: readonly ObjectId[];
  heads: Readonly<Record<RemoteRefName, ObjectId>>;
} {
  const lines = text.split("\n");
  if (lines[0] !== "# v2 git bundle") throw asCorruptBundle(new Error("Unsupported bundle format."));
  const prerequisites: ObjectId[] = [];
  const heads: Record<RemoteRefName, ObjectId> = {};
  for (const line of lines.slice(1)) {
    if (line.startsWith("-")) {
      prerequisites.push(validateObjectId(line.slice(1).split(" ", 1)[0] ?? ""));
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator < 1) throw asCorruptBundle(new Error("Malformed bundle header."));
    heads[validateRemoteRef(line.slice(separator + 1))] = validateObjectId(line.slice(0, separator));
  }
  return { prerequisites: [...new Set(prerequisites)], heads };
}

async function sha256(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function asCorruptBundle(error: unknown): GitStorageError {
  if (error instanceof GitStorageError && error.code === "GIT_NOT_FOUND") return error;
  return new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The remote Git bundle is corrupt or incomplete.", {
    cause: error,
  });
}

function invalidRef(): GitStorageError {
  return new GitStorageError("INVALID_REF", "Invalid remote reference.");
}
