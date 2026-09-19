# Git Storage — Implementation Specification

> **Format-v2 update:** The original format-v1 complete-replacement-bundle design below is retained as historical implementation context. The active storage design is the provider-neutral incremental artifact chain in [`INCREMENTAL_STORAGE.md`](./INCREMENTAL_STORAGE.md). Format-v1 remotes are intentionally unsupported and must be recreated.

Status: implementation-ready draft  
Working directory: `/home/hari/projects/git-storage`  
Language: TypeScript on Node.js  
Distribution: npm package exposing `git-gdrive` and `git-remote-gdrive`  
MVP mode: personal, single-writer Google Drive–backed Git remote

## 1. Objective

Build a working TypeScript command-line package that lets a user use a Google Drive folder as a Git remote:

```bash
npm install --global <package-name>
git gdrive auth login --credentials /path/to/oauth-client.json
git gdrive init --name my-repository
git remote add origin gdrive://<drive-folder-id>
git push -u origin main
git clone gdrive://<drive-folder-id> restored-copy
```

The finished MVP must support normal single-user workflows:

- Initialize a Drive-backed remote.
- Add the remote using a `gdrive://` URL.
- Discover the default branch, branches, and tags.
- Push a new branch.
- Push additional commits.
- Fetch and clone into a fresh directory.
- Pull and pull with rebase; merge and rebase themselves remain local Git operations.
- Create, update, and delete remote branches.
- Push and fetch tags.
- Reject non-fast-forward branch updates unless force was requested.
- Provide useful authentication, configuration, protocol, network, and Git errors.
- Install through npm with the executable names Git expects.

The MVP explicitly does not promise:

- Multiple concurrent writers.
- Atomic compare-and-swap publication on Google Drive.
- Protected branches, server hooks, pull requests, code review, or CI.
- Git LFS.
- Shallow or partial clone.
- Submodule-specific conveniences.
- Efficient storage for large or frequently updated repositories.
- Anonymous public clone.
- Git SHA-256 repositories unless separately enabled and tested later.

## 2. Hard constraints and invariants

These constraints override convenience during implementation.

1. Git owns Git semantics. The application must use Git plumbing commands for object validation, ancestry, bundle creation, bundle import, and ref updates. It must not parse or synthesize Git object files itself.
2. The Drive layer stores opaque bytes and metadata. It does not implement branches, rebase, merge, or commit logic.
3. Remote refs must never be published before all referenced objects are present in the published bundle.
4. A failed push must not replace the last known-good remote bundle or metadata.
5. The remote helper's stdout is protocol-only. Diagnostics, logging, and progress always go to stderr.
6. OAuth client credentials and tokens must never be committed, logged, included in npm packages, fixtures, snapshots, or test output.
7. All tests use temporary repositories and isolated configuration directories. Tests must not read or mutate the developer's real Git configuration, Drive token, or Drive files.
8. Tests verify behavior through the agreed interfaces below. They do not assert private calls or implementation details.
9. Parallel agents may not edit the same files. Any phase without provably disjoint write ownership runs sequentially.
10. The final real Google Drive smoke test is executed manually by the implementing agent and recorded in the handoff; it is not committed as an automated E2E test.

## 3. User-facing interface

### 3.1 npm executables

The package exposes both commands through `package.json`:

```json
{
  "bin": {
    "git-gdrive": "dist/bin/git-gdrive.js",
    "git-remote-gdrive": "dist/bin/git-remote-gdrive.js"
  }
}
```

Both compiled entry files must start with:

```text
#!/usr/bin/env node
```

`git-gdrive` is invoked by users as `git gdrive ...`. `git-remote-gdrive` is invoked automatically by Git when Git encounters the `gdrive://` transport.

### 3.2 CLI commands

Required MVP commands:

```bash
git gdrive auth login --credentials <oauth-client.json>
git gdrive auth status
git gdrive auth logout
git gdrive init --name <repository-name>
git gdrive doctor
git gdrive version
```

Behavior:

- `auth login` runs Desktop OAuth with the `drive.file` scope, copies the OAuth client configuration into the application's private config directory, and stores the resulting token with restrictive permissions where supported.
- `auth status` reports whether credentials and a refreshable token are available. It must not display token values.
- `auth logout` removes the locally stored token only after an explicit command. It does not revoke or delete Drive data in the MVP.
- `init` creates a Drive folder plus repository metadata and prints the canonical remote URL.
- `doctor` checks Node, Git, credentials, token refresh, Drive API access, and local executable discovery. It must be read-only against repository data.
- `version` prints the package version.

Example `init` output:

```text
Created Drive-backed Git remote: my-repository
Remote URL: gdrive://1AbCdEf...

Add it to the current repository with:
  git remote add origin gdrive://1AbCdEf...
```

### 3.3 Remote URL

Canonical form:

```text
gdrive://<drive-folder-id>
```

Accepted convenience inputs for CLI parsing:

```text
https://drive.google.com/drive/folders/<folder-id>
https://drive.google.com/drive/u/<number>/folders/<folder-id>
gdrive::<google-drive-folder-link>
```

The stored Git remote should always be normalized to `gdrive://<folder-id>`. If a shared link includes a resource key, preserve it in the normalized remote URL and propagate it through the helper, application, and repository-store request. The Google Drive adapter supplies the validated `<folder-id>/<resource-key>` pair through the `X-Goog-Drive-Resource-Keys` request header whenever a request directly references the shared folder. Resource keys are routing data, not repository metadata and not secrets.

## 4. Remote storage format

The Drive folder is the stable remote identity. File names are for human inspection only; Drive file IDs are authoritative.

Initial layout:

```text
<Drive folder>
├── repository.json
└── repository.bundle
```

`repository.json` schema:

```json
{
  "formatVersion": 1,
  "repositoryId": "uuid",
  "displayName": "my-repository",
  "objectFormat": "sha1",
  "defaultBranch": "refs/heads/main",
  "bundleFileId": "drive-file-id-or-null",
  "bundleSha256": "hex-or-null",
  "refs": {
    "refs/heads/main": "40-hex-object-id",
    "refs/tags/v1.0.0": "40-hex-object-id"
  },
  "generation": 1,
  "updatedAt": "RFC3339 timestamp",
  "writerId": "local-installation-uuid"
}
```

Drive `appProperties` identify managed files without relying on unique names:

```text
gitStorage.repositoryId=<uuid>
gitStorage.role=metadata|bundle
gitStorage.formatVersion=1
```

Publication order:

1. Build and verify the replacement bundle locally.
2. Upload replacement bundle content to Drive.
3. Read back file metadata and verify size/checksum where available.
4. Update `repository.json` last with refs, checksum, generation, and timestamp.
5. Re-read metadata to detect obvious last-writer races.

For the single-writer MVP, this is recoverable but not a distributed transaction. Document that limitation in the README and `doctor` output where relevant.

## 5. Architecture and module seams

The implementation should concentrate complexity behind a small number of deep modules. Avoid exporting low-level helpers unless another module genuinely needs them.

### 5.1 `AuthSession`

Interface:

```ts
interface AuthSession {
  login(credentialsPath: string): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<void>;
  getAuthorizedClient(): Promise<OAuth2Client>;
  getInstallationId(): Promise<string>;
}
```

Responsibilities hidden behind the interface:

- Parse Desktop OAuth JSON.
- Validate that the credential type is `installed`.
- Run loopback OAuth authorization.
- Persist credentials and refresh token in an isolated config directory.
- Create, validate, and return the stable local installation ID used as metadata `writerId`.
- Refresh expired access tokens.
- Apply restrictive file permissions when supported.
- Redact secrets from all errors and logs.

### 5.2 `RepositoryStore`

This is a real seam because it has two adapters:

- `GoogleDriveRepositoryStore` for production.
- `FilesystemRepositoryStore` for deterministic integration tests and local development.

Interface:

```ts
interface RepositoryStore {
  create(displayName: string): Promise<RemoteDescriptor>;
  readDescriptor(remoteId: string, resourceKey?: string): Promise<RemoteDescriptor>;
  downloadBundle(remote: RemoteDescriptor, destination: string): Promise<void>;
  publish(
    remote: RemoteDescriptor,
    bundlePath: string | null,
    nextMetadata: RepositoryMetadata,
  ): Promise<RemoteDescriptor>;
}
```

Interface invariants:

- `publish` returns only after bundle and metadata publication succeeds.
- `publish` accepts a null bundle only when the next ref map is empty; it then publishes metadata with both bundle fields null and leaves older bundle objects untouched.
- `publish` leaves the previously valid state discoverable on failure whenever the underlying backend permits it.
- `downloadBundle` validates expected size and SHA-256 before returning.
- `readDescriptor` rejects unknown format versions and malformed refs.

### 5.3 `GitRepositoryEngine`

Interface:

```ts
interface GitRepositoryEngine {
  listRefs(bundlePath: string | null): Promise<AdvertisedRefs>;
  importBundle(bundlePath: string, targetGitDir: string): Promise<void>;
  buildNextBundle(input: BuildBundleInput): Promise<BuildBundleResult>;
  verifyBundle(bundlePath: string): Promise<void>;
}
```

`buildNextBundle` is the core deep operation. It must:

1. Create a temporary bare repository.
2. Import the existing remote bundle if one exists.
3. Fetch required source objects from the caller's local Git repository.
4. Apply requested ref creations, updates, deletions, and forced updates.
5. Reject invalid ref names and non-commit objects under `refs/heads/*`.
6. Reject non-fast-forward branch updates unless force was requested.
7. Preserve all remote refs not mentioned by the push.
8. If refs remain, create a complete bundle containing every resulting branch and tag.
9. If no refs remain, return an explicit empty result with no bundle instead of invoking `git bundle create`.
10. Verify non-empty bundle connectivity and return refs plus checksum.
11. Remove its temporary repository on success or failure.

All Git operations run through a single process runner that:

- Uses argument arrays, never shell interpolation.
- Captures stdout and stderr separately.
- Sets explicit working directory and environment.
- Returns structured failures with the command name but without secrets.

### 5.4 `RemoteHelperSession`

Interface:

```ts
interface RemoteHelperSession {
  run(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>;
}
```

Supported capabilities:

```text
fetch
push
option
```

Do not advertise `connect`, `stateless-connect`, `atomic`, shallow-clone, or partial-clone behavior.

Required protocol commands:

- `capabilities`
- `option <name> <value>` with `unsupported` for unsupported options
- `list`
- `list for-push`
- batched `fetch <object-id> <refname>`
- batched `push [+]<src>:<dst>`

Protocol requirements:

- Responses terminate with the blank lines Git expects.
- Fetch imports all objects needed by advertised refs.
- Push returns one `ok <dst>` or `error <dst> <reason>` result per requested ref.
- Fatal details go to stderr; stdout remains parseable.
- `HEAD` is advertised as a symref to the configured default branch.

Reference: <https://git-scm.com/docs/gitremote-helpers>

### 5.5 `GitStorageApplication`

The CLI and remote helper should call one application module rather than coordinate Drive, Git, and auth independently.

Interface:

```ts
interface GitStorageApplication {
  createRemote(name: string): Promise<RemoteDescriptor>;
  listRemote(remoteId: string, resourceKey?: string): Promise<AdvertisedRefs>;
  fetch(request: FetchRequest): Promise<void>;
  push(request: PushRequest): Promise<PushResult[]>;
  doctor(): Promise<DoctorReport>;
}
```

This module owns operation ordering and converts adapter failures into stable domain errors.

## 6. Error model

Define stable error codes and map them to actionable messages:

```text
AUTH_CREDENTIALS_MISSING
AUTH_CREDENTIALS_INVALID
AUTH_REQUIRED
AUTH_REFRESH_FAILED
REMOTE_URL_INVALID
REMOTE_NOT_FOUND
REMOTE_FORMAT_UNSUPPORTED
REMOTE_METADATA_INVALID
REMOTE_BUNDLE_MISSING
REMOTE_BUNDLE_CORRUPT
REMOTE_CHANGED_DURING_PUSH
NON_FAST_FORWARD
INVALID_REF
GIT_NOT_FOUND
GIT_COMMAND_FAILED
DRIVE_PERMISSION_DENIED
DRIVE_RATE_LIMITED
DRIVE_NETWORK_ERROR
INTERNAL_ERROR
```

Rules:

- Domain errors may include safe context such as a ref name or Drive file ID.
- They must never include access tokens, refresh tokens, authorization headers, client secrets, or complete OAuth callback URLs.
- Network retries use bounded exponential backoff with jitter for retryable Drive errors only.
- Git protocol errors are concise on stdout and detailed on stderr.

## 7. Configuration and secrets

Application configuration directory resolution:

1. Use `GIT_GDRIVE_CONFIG_DIR` when explicitly set; tests always set it.
2. Otherwise use the operating system's standard per-user config directory.

Stored files:

```text
<config-dir>/oauth-client.json
<config-dir>/token.json
<config-dir>/installation.json
```

Deterministic local-development and real-process integration tests may set:

```text
GIT_GDRIVE_FILESYSTEM_STORE_DIR=<isolated-temporary-directory>
```

When set, the production composition root uses `FilesystemRepositoryStore` instead of contacting Drive. This is an explicit local testing seam, not a second user-facing remote format; tests must also isolate `GIT_GDRIVE_CONFIG_DIR`.

The current development credentials are located outside source control at:

```text
/home/hari/projects/git-storage/.secrets/google-oauth-client.json
/home/hari/projects/git-storage/.secrets/token.json
```

Required `.gitignore` entries:

```gitignore
.secrets/
.env
.env.*
node_modules/
dist/
coverage/
*.tgz
```

The npm package allowlist must exclude `.secrets`, tests containing local paths, coverage, temporary repositories, and development tokens.

## 8. Proposed source tree and exclusive ownership

```text
git-storage/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── README.md
├── IMPLEMENTATION_SPEC.md
├── src/
│   ├── application/
│   │   ├── git-storage-application.ts
│   │   └── runtime.ts
│   ├── auth/
│   │   ├── auth-session.ts
│   │   └── config-paths.ts
│   ├── bin/
│   │   ├── git-gdrive.ts
│   │   └── git-remote-gdrive.ts
│   ├── cli/
│   │   └── cli.ts
│   ├── domain/
│   │   ├── errors.ts
│   │   ├── metadata.ts
│   │   ├── refs.ts
│   │   └── remote-url.ts
│   ├── git/
│   │   ├── git-process.ts
│   │   └── git-repository-engine.ts
│   ├── remote-helper/
│   │   ├── protocol.ts
│   │   └── remote-helper-session.ts
│   └── storage/
│       ├── repository-store.ts
│       ├── filesystem-repository-store.ts
│       └── google-drive-repository-store.ts
└── tests/
    ├── unit/
    │   ├── auth-session.test.ts
    │   ├── metadata.test.ts
    │   ├── protocol.test.ts
    │   ├── refs.test.ts
    │   └── remote-url.test.ts
    ├── integration/
    │   ├── bundle-engine.test.ts
    │   ├── cli-package.test.ts
    │   ├── remote-helper-fetch.test.ts
    │   └── remote-helper-push.test.ts
    └── support/
        ├── git-fixture.ts
        ├── isolated-environment.ts
        └── test-repository-store.ts
```

No parallel worker may modify `package.json`, `package-lock.json`, TypeScript configuration, test configuration, shared domain types, or application wiring. Those files belong to the phase lead and are changed only between parallel rounds.

## 9. Testing seams requiring approval before implementation

The formal tests will verify behavior at these seams:

1. Domain parsing seam: remote URLs, metadata documents, refspecs, and protocol lines in; validated domain values or stable errors out.
2. Authentication seam: credentials plus isolated config directory in; auth status or safe errors out. Browser interaction is injected, not opened by unit tests.
3. Repository storage seam: bundle and metadata in; downloadable verified state out, using the filesystem adapter for deterministic tests.
4. Git engine seam: existing bundle plus ref updates in; verified replacement bundle and refs out, using real temporary Git repositories.
5. Remote helper process seam: protocol input in; exact protocol output and resulting Git object availability out.
6. Packaged CLI seam: npm-installed executables invoked by real Git in isolated temporary directories.

Tests must not target private methods, internal call order, or make live Google client calls. A narrow injected googleapis-shaped wrapper may assert safety-critical request options such as a resource-key header, but repository behavior stays covered through the public `RepositoryStore` seam. The real Google Drive adapter is validated in the final manual smoke test rather than a committed live-account test.

Approval rule: implementation starts only after the user approves this spec or explicitly asks to proceed with it. That approval confirms the testing seams above as required by the TDD workflow.

## 10. TDD execution rules

Every implementation phase follows vertical red-green slices:

1. Add one behavior test at an approved seam.
2. Run it and record that it fails for the expected reason.
3. Implement only enough behavior to make that test pass.
4. Run the focused test.
5. Run all tests in the affected suite.
6. Continue with the next behavior.

Do not write an entire test suite before implementation. Do not refactor during the red-green loop; schedule cleanup after the phase gate while all tests are green.

Each phase handoff must include:

- Files changed.
- Tests added and behavior covered.
- The initial failing command and reason.
- Final verification commands and results.
- Known limitations or follow-up work.

## 11. Implementation phases and agent orchestration

### Phase 0 — Repository bootstrap

Execution: sequential, phase lead only.  
Reason: every later worker depends on shared root configuration.

Tasks:

1. Initialize Git in `/home/hari/projects/git-storage` if it is not already a repository.
2. Add `.gitignore` before any credential-aware work.
3. Create `package.json`, lockfile, TypeScript, lint, and Vitest configuration.
4. Configure Node and package engine requirements.
5. Add npm scripts:

```json
{
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint .",
  "test": "vitest run",
  "test:unit": "vitest run tests/unit",
  "test:integration": "vitest run tests/integration",
  "verify": "npm run lint && npm run typecheck && npm run test && npm run build"
}
```

6. Declare executable entries and npm package file allowlist.
7. Add placeholder bin entry files that fail with a clear “not implemented” error.
8. Run `npm pack --dry-run` and verify secrets are absent.

Gate:

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

### Phase 1 — Domain and protocol foundations

Execution: one controlled parallel round after Phase 0.  
Parallel safety: workers receive disjoint source and test files and may not edit shared configuration.

Worker 1A — Remote URL and metadata

Exclusive write set:

```text
src/domain/remote-url.ts
src/domain/metadata.ts
tests/unit/remote-url.test.ts
tests/unit/metadata.test.ts
```

Behaviors:

- Parse and normalize canonical and accepted convenience URLs.
- Reject malformed, empty, or unsupported URLs.
- Validate metadata version, object IDs, ref map, checksum, and default branch.
- Reject unknown format versions and malformed metadata with stable errors.

Worker 1B — Refs and remote-helper protocol grammar

Exclusive write set:

```text
src/domain/refs.ts
src/remote-helper/protocol.ts
tests/unit/refs.test.ts
tests/unit/protocol.test.ts
```

Behaviors:

- Parse list, fetch, push, force-push, and delete lines.
- Serialize capabilities, advertised refs, symrefs, options, and push status.
- Correctly batch commands terminated by blank lines.
- Reject malformed refspecs without contaminating stdout.

Phase lead integration after both workers finish:

- Review both write sets.
- Resolve imports in a single lead-owned commit.
- Add or adjust shared `src/domain/errors.ts` if needed.
- Run all unit tests, typecheck, and lint.

Gate:

```bash
npm run test:unit
npm run typecheck
npm run lint
```

### Phase 2 — Storage and authentication

Execution: one controlled parallel round.  
Dependency: Phase 1 metadata contract is frozen for this phase.

Worker 2A — Repository storage adapters

Exclusive write set:

```text
src/storage/repository-store.ts
src/storage/filesystem-repository-store.ts
src/storage/google-drive-repository-store.ts
tests/support/test-repository-store.ts
tests/integration/repository-store.test.ts
```

Behaviors:

- Create repository folder and metadata.
- Locate managed files through Drive IDs and app properties.
- Download and checksum bundles.
- Publish bundle first and metadata last.
- Preserve last valid metadata on upload failure where possible.
- Publish an explicit empty remote when all refs are deleted, without deleting superseded bundle objects.
- Filesystem adapter matches the same observable contract.
- Rate-limit and network errors map to stable domain errors.

Google Drive tests in this phase use an injected external-client adapter or deterministic fake responses; they do not use the real account.

Worker 2B — OAuth and config isolation

Exclusive write set:

```text
src/auth/auth-session.ts
src/auth/config-paths.ts
tests/unit/auth-session.test.ts
tests/support/isolated-environment.ts
```

Behaviors:

- Accept only Desktop OAuth credential JSON.
- Store copied OAuth credentials and token in isolated config directory.
- Refresh an expired token.
- Report status without displaying secrets.
- Respect `GIT_GDRIVE_CONFIG_DIR`.
- Logout removes only the token.
- Unit tests inject browser/OAuth behavior and never open a real browser.

Phase lead integration:

- Wire dependencies without changing worker-owned behavior.
- Audit logs and errors for credential leakage.
- Confirm `.secrets` and tokens are absent from `npm pack --dry-run`.

Gate:

```bash
npm run test:unit
npm run test:integration -- repository-store
npm run typecheck
npm run lint
npm pack --dry-run
```

### Phase 3 — Git bundle engine

Execution: sequential.  
Reason: Git process execution, bundle lifecycle, temporary repositories, and ref semantics are tightly coupled.

Exclusive write set:

```text
src/git/git-process.ts
src/git/git-repository-engine.ts
tests/support/git-fixture.ts
tests/integration/bundle-engine.test.ts
```

Vertical slices:

1. Create a complete bundle from one commit and import it into an empty bare repository.
2. Advertise main and HEAD correctly.
3. Preserve an existing branch while adding another branch.
4. Preserve and fetch annotated and lightweight tags.
5. Add a fast-forward commit to an existing branch.
6. Reject a non-fast-forward update.
7. Accept the same update when force is explicit.
8. Delete a branch while preserving unrelated refs.
9. Delete the final remaining ref and return an explicit no-bundle empty result.
10. Reject a branch update pointing to a non-commit object.
11. Detect a corrupt or disconnected bundle.
12. Clean temporary repositories after success and failure.

Every integration test uses real `git` commands and temporary directories. Expected commit IDs and refs come from independently queried fixture repositories, not from implementation internals.

Gate:

```bash
npm run test:integration -- bundle-engine
git --version
npm run typecheck
npm run lint
```

### Phase 4 — Application orchestration

Execution: sequential.  
Reason: this module establishes operation ordering shared by both CLI and remote helper.

Exclusive write set:

```text
src/application/git-storage-application.ts
tests/integration/application.test.ts
```

Vertical slices:

1. Create an empty remote.
2. List an empty remote with no bundle.
3. Publish the first branch.
4. Fetch the published branch into a new repository.
5. Publish a subsequent fast-forward update.
6. Preserve unrelated refs during an update.
7. Surface stable errors from auth, storage, and Git modules.
8. Detect obvious metadata generation changes during push.

Gate:

```bash
npm run test:integration -- application
npm run test:unit
npm run typecheck
npm run lint
```

### Phase 5 — CLI and remote helper

Execution: one controlled parallel round after the application interface is frozen.

Worker 5A — Human CLI

Exclusive write set:

```text
src/cli/cli.ts
src/bin/git-gdrive.ts
tests/integration/cli-package.test.ts
```

Behaviors:

- Auth login/status/logout.
- Init and canonical URL output.
- Doctor checks with nonzero exit on failed required checks.
- Version output.
- Human-readable errors on stderr and stable exit codes.

Worker 5B — Git remote helper

Exclusive write set:

```text
src/remote-helper/remote-helper-session.ts
src/bin/git-remote-gdrive.ts
tests/integration/remote-helper-fetch.test.ts
tests/integration/remote-helper-push.test.ts
```

Behaviors:

- Capability negotiation.
- List and HEAD symref advertisement.
- Fetch into a real local Git object database.
- Initial push, fast-forward push, branch creation, tag push, force push, and ref deletion.
- Exact status lines and blank-line framing.
- Protocol stdout remains clean when errors occur.

Both workers use the filesystem storage adapter and isolated config. Neither worker may edit the application module, domain modules, package configuration, or the other worker's files.

Phase lead integration:

- Build package.
- Install the packed tarball into a temporary npm prefix.
- Verify both executable names are present on PATH.
- Run the complete offline Git integration suite.

Gate:

```bash
npm run verify
npm pack
npm install --global --prefix <temporary-prefix> ./<generated-package>.tgz
PATH=<temporary-prefix>/bin:$PATH git gdrive version
PATH=<temporary-prefix>/bin:$PATH git-remote-gdrive 2>&1
```

### Phase 6 — Documentation and security review

Execution: mostly sequential; one read-only review agent may run in parallel with lead-owned README edits because it has no write permission.

Lead-owned write set:

```text
README.md
package.json
```

Documentation must include:

- Experimental single-writer warning.
- Installation from npm and directly from GitHub.
- Google Cloud OAuth setup.
- Exact auth, init, remote-add, push, clone, fetch, pull, and recovery examples.
- Why a normal Drive HTTPS link cannot be used directly as a Git remote.
- Security and token-storage notes.
- Feature limitations.
- Troubleshooting for PATH, Git discovery, OAuth testing expiry, permissions, and Drive rate limits.

Security review checklist:

- Search repository and npm tarball for credential keys and tokens.
- Confirm stdout protocol cleanliness.
- Confirm no shell command interpolation.
- Confirm all temporary paths are explicit and narrowly scoped.
- Confirm checksum validation before bundle import.
- Confirm malformed metadata cannot produce arbitrary paths or commands.
- Confirm errors redact secrets and OAuth URLs.
- Confirm dependencies and lockfile are present.

Gate:

```bash
npm run verify
npm audit
npm pack --dry-run
rg -n "refresh_token|client_secret|access_token" . -g '!node_modules/**' -g '!.secrets/**'
```

Any intentional schema or test fixture references to those key names must contain fake values and be reviewed manually.

### Phase 7 — Final manual Google Drive E2E smoke test

Execution: sequential, performed by the lead agent.  
Formal test file: none.  
Account: configured dummy Google account only.

Preparation:

1. Run `npm run verify`.
2. Produce an npm tarball with `npm pack`.
3. Install it into a fresh temporary npm prefix.
4. Set a temporary PATH that contains only the packaged executables plus normal system tools.
5. Import or authenticate using the existing dummy-account OAuth credentials.
6. Use unique temporary local directories and a uniquely named Drive remote folder.

Smoke sequence:

```bash
# Source repository
git init source
cd source
git config user.name "Git Storage Smoke Test"
git config user.email "smoke@example.invalid"
echo first > file.txt
git add file.txt
git commit -m "first"
git branch -M main
git tag v0.1.0

# Create Drive remote and push
git gdrive init --name "git-storage-e2e-<timestamp>"
git remote add origin gdrive://<folder-id>
git push -u origin main
git push origin v0.1.0

# Fresh clone
cd ..
git clone gdrive://<folder-id> clone-one
git -C clone-one fsck --full

# Second branch and commit
git -C source switch -c feature
echo feature >> source/file.txt
git -C source add file.txt
git -C source commit -m "feature"
git -C source push -u origin feature

# Fetch branch into existing clone
git -C clone-one fetch origin
git -C clone-one show-ref --verify refs/remotes/origin/feature

# Fast-forward main
git -C source switch main
echo second >> source/file.txt
git -C source add file.txt
git -C source commit -m "second"
git -C source push origin main
git -C clone-one pull --ff-only origin main

# Local rebase then push
git -C source switch feature
git -C source rebase main
git -C source push --force-with-lease origin feature

# Third independent clone
git clone gdrive://<folder-id> clone-two
git -C clone-two fsck --full
```

Assertions performed manually by the agent:

- Source, `clone-one`, and `clone-two` resolve the same `main` object ID.
- Feature resolves to the expected rebased object ID.
- Tag `v0.1.0` resolves identically in source and clones.
- `git fsck --full` succeeds in both clones.
- File contents match expected literals.
- Remote tracking refs are present.
- A normal non-fast-forward push is rejected.
- A forced update succeeds only when explicitly requested.
- No credentials appear in command output or npm tarball.
- Drive contains the repository folder, metadata file, and bundle file.

Cleanup:

- Remove only the uniquely created local temporary directories.
- Keep the uniquely named Drive E2E folder for user inspection by default.
- Move the Drive folder to trash only if the user explicitly requests cleanup.
- Report the Drive folder ID, commands run, pass/fail results, and any limitations.

## 12. Formal test inventory

### Unit tests

`remote-url.test.ts`

- Canonical `gdrive://` URL.
- Drive folder links with and without account index.
- Explicit helper syntax.
- Resource-key preservation.
- Empty, malformed, and unsupported URLs.

`metadata.test.ts`

- Empty remote metadata.
- Valid populated metadata.
- Unknown version.
- Invalid object format.
- Invalid checksum, timestamp, refs, and default branch.
- Metadata serialization round trip.

`refs.test.ts`

- Branch, tag, force, and deletion refspecs.
- Invalid destination and invalid branch object type.
- Fast-forward policy inputs.

`protocol.test.ts`

- Capabilities framing.
- Options and unsupported options.
- List and list-for-push.
- Fetch and push batches.
- Blank-line termination.
- Error serialization and stdout cleanliness.

`auth-session.test.ts`

- Desktop credentials accepted.
- Web credentials rejected.
- Missing credentials.
- Login persistence in isolated config.
- Expired-token refresh.
- Logout removes token.
- Stable installation ID creation, repeat retrieval, malformed-record rejection, and private permissions.
- Secret-redacted errors.

### Integration tests

`repository-store.test.ts`

- Filesystem adapter contract.
- Create/read/publish/download cycle.
- Checksum mismatch.
- Interrupted publication preserves old state.
- Unknown remote and malformed metadata.

`bundle-engine.test.ts`

- Complete bundle creation and import.
- Multiple branches and tags.
- Fast-forward update.
- Non-fast-forward rejection and explicit force.
- Ref deletion.
- Final-ref deletion produces an empty remote with no bundle.
- Remote-only ref preservation.
- Corrupt bundle rejection.
- Temporary repository cleanup.

`application.test.ts`

- Empty remote lifecycle.
- First push and fetch.
- Subsequent push.
- Stable domain errors.
- Generation-change warning/error.

`remote-helper-fetch.test.ts`

- Real Git invokes helper.
- Clone from initialized remote.
- Fetch new branch and tag.
- HEAD/default branch behavior.
- Protocol failure produces useful Git error.

`remote-helper-push.test.ts`

- Initial push.
- Fast-forward push.
- New branch and tag.
- Non-fast-forward rejection.
- Force push.
- Delete branch.
- Preserve unrelated refs.

`cli-package.test.ts`

- Packed npm tarball installs into temporary prefix.
- Both executable names are available.
- `git gdrive version` works.
- Real Git performs at least one push and clone through the helper installed from that packed prefix.
- `doctor` reports isolated missing/present credentials correctly.
- Package contains no development secrets.

## 13. Parallel-agent safety protocol

Before spawning a parallel round, the lead agent must:

1. Commit or otherwise freeze the phase baseline.
2. Give every worker an explicit exclusive write set.
3. State forbidden shared files in each worker prompt.
4. Ensure workers do not run formatting commands over the whole repository.
5. Ensure generated lockfiles are lead-owned.
6. Require workers to report every changed path.
7. Reject any worker result that edited outside its assigned set.

During parallel rounds:

- Workers may read any project file.
- Workers may only write their assigned files.
- Workers run focused tests, not repository-wide autofix commands.
- Workers do not rebase, merge, install dependencies, or modify Git configuration.
- Workers do not touch `.secrets` or real Google Drive data.

After parallel rounds:

1. Lead reviews diffs before integration.
2. Lead integrates workers one at a time.
3. Lead resolves shared imports and shared configuration centrally.
4. Lead runs the full phase gate after all results are integrated.
5. No next phase begins while the gate is red.

When there is any uncertainty about overlap, run the work sequentially.

## 14. Definition of done

The implementation is complete only when all of the following are true:

- `npm ci` succeeds from a clean checkout.
- `npm run verify` succeeds.
- Unit and integration tests cover the behaviors listed above.
- Real Git invokes the installed `git-remote-gdrive` executable.
- `git push`, `git clone`, `git fetch`, and `git pull` work against the dummy Google Drive account.
- Branches and tags survive independent clones.
- Non-fast-forward updates are rejected unless forced.
- `git fsck --full` succeeds after clone and fetch workflows.
- npm package installation exposes both executables.
- `npm pack --dry-run` contains no credentials, tokens, local paths, or unnecessary development files.
- README accurately documents installation, OAuth setup, commands, limitations, and recovery.
- Final manual E2E smoke sequence passes and is reported without committing a live-account test.
- No shared-file overwrite occurred during parallel agent work.

## 15. Implementation handoff order

The recommended orchestration order is:

```text
Phase 0 sequential
    ↓
Phase 1A + 1B parallel, then lead integration
    ↓
Phase 2A + 2B parallel, then lead integration
    ↓
Phase 3 sequential
    ↓
Phase 4 sequential
    ↓
Phase 5A + 5B parallel, then lead integration
    ↓
Phase 6 sequential with optional read-only review in parallel
    ↓
Phase 7 manual real-Drive E2E
```

This ordering prioritizes correctness and avoids parallel edits to shared architecture, configuration, and package files.

## 16. Spec deviation ledger

### 2026-08-23 — Phase 2 integration: installation writer identity seam

- Original specification: `AuthSession` persisted `installation.json`, while its interface exposed only login, status, logout, and authorized-client operations.
- Evidence requiring change: `RepositoryMetadata.writerId` and both repository-store adapters require the stable local installation UUID, but no module interface allowed the application composition root to obtain it. Reading the private auth file from unrelated wiring would duplicate validation and leak implementation details across the auth seam.
- Decision taken: add `AuthSession.getInstallationId(): Promise<string>`; it creates or reads and validates the private installation record and returns only the non-secret UUID. Human-facing auth status remains unchanged.
- Mission justification: a stable writer ID supports understandable single-writer backup metadata and recoverability without adding collaboration or coordination infrastructure.
- Files or phases affected: `IMPLEMENTATION_SPEC.md`; Phase 2B auth implementation/tests; later Phase 4/5 composition wiring.
- Tests added or changed: Phase 2B unit coverage for stable creation, repeat retrieval, malformed-record rejection, and private permissions.
- Date/phase: 2026-08-23, Phase 2 integration.

### 2026-08-23 — Phase 3 design: empty remote after final-ref deletion

- Original specification: `GitRepositoryEngine.buildNextBundle` always produced a complete bundle, and `RepositoryStore.publish` always required a bundle path, while metadata independently allowed an empty ref map with null bundle fields.
- Evidence requiring change: Git refuses `git bundle create` when no refs are selected. Deleting the final remote ref therefore could not satisfy both Git's format and the promised remote-branch deletion behavior.
- Decision taken: represent an empty result explicitly with no bundle. `buildNextBundle` returns null bundle/checksum when no refs remain; `RepositoryStore.publish` accepts a null bundle only with an empty ref map, publishes null bundle metadata last, and retains superseded bundle objects for recovery.
- Mission justification: this preserves normal single-user ref deletion semantics using Git's real bundle format, without sentinels, custom objects, destructive cleanup, or coordination infrastructure.
- Files or phases affected: `IMPLEMENTATION_SPEC.md`; Phase 2A storage interface/adapters/tests; Phase 3 engine/tests; Phase 4 application orchestration.
- Tests added or changed: storage transition from populated to empty; final-ref deletion engine behavior; later application empty-remote lifecycle coverage.
- Date/phase: 2026-08-23, Phase 3 design.

### 2026-08-23 — Phase 5 integration: deterministic executable storage seam

- Original specification: integration tests used `FilesystemRepositoryStore`, but no composition mechanism let real packaged CLI/helper processes select it; both executables otherwise constructed the Google Drive adapter directly.
- Evidence requiring change: real Git must discover and invoke `git-remote-gdrive` as a subprocess in formal tests, where dependency injection cannot cross the process boundary. Using the dummy live Drive account in committed integration tests would violate the isolated-test invariant.
- Decision taken: add one lead-owned runtime composition module and the explicit `GIT_GDRIVE_FILESYSTEM_STORE_DIR` environment seam. When present, runtime operations use the filesystem adapter in that isolated directory; normal executions continue to use authorized Google Drive. Both bins share this composition root.
- Mission justification: this verifies real Git/package behavior deterministically without adding a hosted backend or user-facing storage mode and without touching live credentials/data.
- Files or phases affected: `IMPLEMENTATION_SPEC.md`; lead-owned `src/application/runtime.ts`; Phase 5A/5B process/package tests and bin wiring.
- Tests added or changed: real-process CLI/helper tests set isolated config and filesystem-store directories; live Drive remains final manual E2E only.
- Date/phase: 2026-08-23, Phase 5 integration.

### 2026-08-23 — Phase 7 review: default-branch continuity

- Original specification: newly created remotes defaulted to `refs/heads/main`, but publication preserved that field unchanged for every ref update.
- Evidence requiring change: a valid first push to a differently named branch, or deletion of `main` while another branch remains, left metadata advertising a dangling `HEAD` symref. Real Git clone then could not check out the available branch even though the bundle and ref were valid.
- Decision taken: preserve the configured default while it exists; otherwise select the lexicographically first remaining branch during publication. If no branch exists, retain the configured branch name so empty/tag-only metadata still satisfies the branch-valued schema.
- Mission justification: normal branch push and clone must restore a usable working tree without adding a branch-selection command or collaboration policy.
- Files or phases affected: `IMPLEMENTATION_SPEC.md`; Phase 4 application orchestration/tests; Phase 5B helper clone coverage; README.
- Tests added or changed: first non-`main` branch publication and clone advertises/checks out that branch; deletion fallback remains deterministic.
- Date/phase: 2026-08-23, Phase 7 review.

### 2026-08-23 — Phase 7 review: resource-key propagation contract

- Original specification: Drive links with a resource key were parsed and normalized, but the application/store interfaces accepted only a folder ID.
- Evidence requiring change: the helper discarded `ParsedRemoteUrl.resourceKey`, so link-shared folders that require Google Drive resource keys could not be resolved despite the accepted URL syntax.
- Decision taken: carry the optional validated resource key through remote-helper session requests, application requests, and `RepositoryStore.readDescriptor`; the Google adapter adds Google’s `X-Goog-Drive-Resource-Keys` header for requests that directly reference the shared folder. The key is not persisted in Drive metadata.
- Mission justification: this completes the already promised convenience URL behavior with the smallest request-scoped change and no new remote format.
- Files or phases affected: `IMPLEMENTATION_SPEC.md`; Phase 2A storage seam/adapter/tests; Phase 4 application seam/tests; Phase 5B helper/bin/tests.
- Tests added or changed: propagation at application/helper seams and Drive external-client header construction with safe validated values.
- Date/phase: 2026-08-23, Phase 7 review.
