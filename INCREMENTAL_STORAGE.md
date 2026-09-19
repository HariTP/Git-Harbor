# Incremental storage design

Git Storage format version 2 stores an ordered chain of immutable Git bundle artifacts. The first artifact is a self-contained base. Later artifacts contain objects newly required by ref updates and may declare prerequisite commits already present in earlier artifacts.

## Provider-neutral seam

`RepositoryStore` describes repository operations rather than cloud-file operations:

```ts
interface RepositoryStore {
  create(displayName: string): Promise<RemoteDescriptor>;
  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor>;
  downloadArtifact(remote: RemoteDescriptor, artifact: ArtifactDescriptor, destination: string): Promise<void>;
  publish(remote: RemoteDescriptor, change: RepositoryChange): Promise<RemoteDescriptor>;
}
```

Google Drive file IDs, app properties, retries, checksums, and routing headers remain inside `GoogleDriveRepositoryStore`. Future providers implement the same interface with their own storage mechanics.

## Push

1. Read the current descriptor and refs.
2. Validate branch fast-forward, force, tag, and deletion semantics locally with Git.
3. Build a base or incremental bundle. Existing remote tips are used as prerequisites only when those objects exist locally.
4. Verify the bundle and record its actual header prerequisites and heads.
5. Upload and verify the immutable artifact.
6. Publish metadata last with the new refs and appended artifact descriptor.

If artifact upload succeeds but metadata publication fails, the artifact is an unreachable orphan and the previous descriptor remains authoritative.

## Fetch

1. Read the requested object IDs from Git's remote-helper fetch commands.
2. Return immediately when all requested objects already exist locally.
3. Walk artifacts in metadata order, skipping artifacts whose advertised heads already exist locally.
4. Download, checksum, `git bundle verify`, and unbundle each required artifact.
5. Fail if the requested objects are still absent after the chain is applied.

The local object database and bundle prerequisites are authoritative. A future applied-artifact cache may optimize discovery but must not be required for correctness.

## Concurrency and retention

Format version 2 remains single-writer. Metadata generations detect common stale publication attempts, but Google Drive publication is not claimed to be an atomic compare-and-swap. Concurrent pushes to one remote are unsupported.

Artifacts remain append-only. Ref deletion and force pushes can leave unreachable objects, which is safe and useful for recovery. Periodic compaction and garbage collection are future work.

Format version 1 remotes are intentionally unsupported by this pre-release format change and must be recreated.
