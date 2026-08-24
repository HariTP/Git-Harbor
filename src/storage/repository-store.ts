import type { RepositoryMetadata } from "../domain/metadata.js";

/**
 * The stable identity and validated state of a stored repository.
 * Storage-specific file names and implementation details stay behind this seam.
 */
export interface RemoteDescriptor {
  readonly remoteId: string;
  readonly metadata: RepositoryMetadata;
  readonly resourceKey?: string;
}

export interface RepositoryStore {
  create(displayName: string): Promise<RemoteDescriptor>;
  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor>;
  downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void>;
  publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor>;
}
