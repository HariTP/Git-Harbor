import { GitStorageError } from "../domain/errors.js";
import {
  type ObjectId,
  type PushRefspec,
  type BranchRefName,
  type RemoteRefName,
  validateObjectId,
  validateRemoteRef,
} from "../domain/refs.js";
import {
  GitRepositoryEngine,
  type AdvertisedRefs,
} from "../git/git-repository-engine.js";
import type { RemoteDescriptor, RepositoryStore } from "../storage/repository-store.js";

export interface FetchRequest {
  readonly remoteId: string;
  readonly resourceKey?: string;
  readonly targetGitDir: string;
  readonly wants?: readonly ObjectId[];
  readonly temporaryDirectoryParent?: string;
}

export interface PushRequest {
  readonly remoteId: string;
  readonly resourceKey?: string;
  readonly localGitDir: string;
  readonly updates: readonly PushRefspec[];
  readonly temporaryDirectoryParent?: string;
}

export type PushResult =
  | { readonly destination: RemoteRefName; readonly ok: true }
  | { readonly destination: RemoteRefName; readonly ok: false; readonly reason: string };

export interface RemoteAdvertisement extends AdvertisedRefs {
  readonly defaultBranch: BranchRefName;
}

export interface DoctorCheck {
  readonly name: string;
  readonly required: boolean;
  check(): Promise<void>;
}

export interface DoctorCheckResult {
  readonly name: string;
  readonly required: boolean;
  readonly ok: boolean;
  readonly message?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheckResult[];
}

export interface GitStorageApplicationOptions {
  readonly store: RepositoryStore;
  readonly git: GitRepositoryEngine;
  readonly doctorChecks?: readonly DoctorCheck[];
}

/** Coordinates the storage and Git seams for a single remote operation. */
export class GitStorageApplication {
  private readonly store: RepositoryStore;
  private readonly git: GitRepositoryEngine;
  private readonly doctorChecks: readonly DoctorCheck[];

  constructor(options: GitStorageApplicationOptions) {
    this.store = options.store;
    this.git = options.git;
    this.doctorChecks = options.doctorChecks ?? [];
  }

  async createRemote(name: string): Promise<RemoteDescriptor> {
    return this.store.create(name);
  }

  async listRemote(remoteId: string, resourceKey?: string): Promise<RemoteAdvertisement> {
    const remote = await this.store.readDescriptor(remoteId, resourceKey);
    const defaultBranch = validateRemoteRef(remote.metadata.defaultBranch);
    if (!defaultBranch.startsWith("refs/heads/")) {
      throw new GitStorageError("REMOTE_METADATA_INVALID", "The repository metadata is invalid.");
    }
    return {
      defaultBranch: defaultBranch as BranchRefName,
      refs: Object.entries(remote.metadata.refs)
        .map(([name, objectId]) => ({ name: validateRemoteRef(name), objectId: validateObjectId(objectId) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async fetch(request: FetchRequest): Promise<void> {
    const remote = await this.store.readDescriptor(request.remoteId, request.resourceKey);
    const wants = request.wants ?? Object.values(remote.metadata.refs).map(validateObjectId);
    if (await this.hasAllObjects(request.targetGitDir, wants)) {
      return;
    }
    await this.withTemporaryDirectory(request.temporaryDirectoryParent, async (directory) => {
      for (const [index, artifact] of remote.metadata.artifacts.entries()) {
        if (await this.hasAllObjects(request.targetGitDir, Object.values(artifact.heads).map(validateObjectId))) {
          continue;
        }
        const bundlePath = `${directory}/artifact-${index}.bundle`;
        await this.store.downloadArtifact(remote, artifact, bundlePath);
        await this.git.importArtifact(bundlePath, request.targetGitDir);
        if (await this.hasAllObjects(request.targetGitDir, wants)) return;
      }
      if (!(await this.hasAllObjects(request.targetGitDir, wants))) {
        throw new GitStorageError("REMOTE_BUNDLE_CORRUPT", "The remote artifacts do not contain the requested objects.");
      }
    });
  }

  async push(request: PushRequest): Promise<PushResult[]> {
    const remote = await this.store.readDescriptor(request.remoteId, request.resourceKey);
    try {
      await this.withTemporaryDirectory(request.temporaryDirectoryParent, async (directory) => {
        const bundlePath = `${directory}/incremental.bundle`;
        const result = await this.git.buildIncrementalArtifact({
          currentRefs: remote.metadata.refs,
          hasRemoteArtifacts: remote.metadata.artifacts.length > 0,
          localGitDir: request.localGitDir,
          updates: request.updates,
          outputBundlePath: bundlePath,
          temporaryDirectoryParent: directory,
        });
        const defaultBranch = Object.hasOwn(result.refs, remote.metadata.defaultBranch)
          ? remote.metadata.defaultBranch
          : Object.keys(result.refs).filter((ref) => ref.startsWith("refs/heads/")).sort()[0]
            ?? remote.metadata.defaultBranch;
        await this.store.publish(remote, {
          artifact: result.artifact,
          refs: result.refs,
          defaultBranch,
        });
      });
      return request.updates.map((update) => ({ destination: validateRemoteRef(update.destination), ok: true }));
    } catch (error) {
      if (error instanceof GitStorageError &&
        (error.code === "NON_FAST_FORWARD" || error.code === "INVALID_REF")) {
        return request.updates.map((update) => ({
          destination: validateRemoteRef(update.destination),
          ok: false,
          reason: error.code,
        }));
      }
      throw error;
    }
  }

  async doctor(): Promise<DoctorReport> {
    const checks = await Promise.all(this.doctorChecks.map(async (check): Promise<DoctorCheckResult> => {
      try {
        await check.check();
        return { name: check.name, required: check.required, ok: true };
      } catch {
        return { name: check.name, required: check.required, ok: false, message: "check failed" };
      }
    }));
    return { ok: checks.filter((check) => check.required).every((check) => check.ok), checks };
  }

  private async withTemporaryDirectory<T>(parent: string | undefined, action: (directory: string) => Promise<T>): Promise<T> {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(parent ?? tmpdir(), "git-storage-application-"));
    try {
      return await action(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async hasAllObjects(gitDir: string, objectIds: readonly ObjectId[]): Promise<boolean> {
    for (const objectId of objectIds) {
      if (!(await this.git.hasObject(gitDir, objectId))) return false;
    }
    return true;
  }
}
