import type {
  ArtifactDescriptor,
  ArtifactKind,
  RepositoryMetadata,
} from "../domain/metadata.js";

export interface RemoteDescriptor {
  readonly remoteId: string;
  readonly metadata: RepositoryMetadata;
  readonly resourceKey?: string;
}

export interface LocalArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly size: number;
  readonly prerequisites: readonly string[];
  readonly heads: Readonly<Record<string, string>>;
}

export interface RepositoryChange {
  readonly artifact: LocalArtifact | null;
  readonly refs: Readonly<Record<string, string>>;
  readonly defaultBranch: string;
}

/** Provider-neutral repository storage seam. */
export interface RepositoryStore {
  create(displayName: string): Promise<RemoteDescriptor>;
  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor>;
  downloadArtifact(
    remote: RemoteDescriptor,
    artifact: ArtifactDescriptor,
    destination: string,
  ): Promise<void>;
  publish(remote: RemoteDescriptor, change: RepositoryChange): Promise<RemoteDescriptor>;
}
