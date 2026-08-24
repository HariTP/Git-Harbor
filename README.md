# Git Storage

Git Storage is an experimental Git remote helper that uses a folder in your own Google Drive as a backup remote. Git continues to own commits, refs, merges, rebases, and integrity checks; Git Storage turns each remote state into a complete, verified Git bundle plus small metadata in Drive.

> [!WARNING]
> This is a single-user, single-writer side project. Do not push to the same Drive remote concurrently. It is designed as a personal backup or secondary remote, not as a replacement for GitHub, GitLab, or another collaborative forge.

## Requirements

- Node.js 22 or newer and npm 10 or newer
- Git available on `PATH`
- A Google account with Drive enabled
- A Google Cloud Desktop OAuth client
- A local browser for the initial OAuth flow

## Installation

From npm, once the package is published:

```bash
npm install --global git-storage-gdrive
git gdrive version
```

To install directly from the GitHub source repository:

```bash
npm install --global 'git+https://github.com/<github-owner>/git-storage.git'
```

The package's `prepare` lifecycle builds the TypeScript sources for a Git dependency. Alternatively, inspect and build a checkout yourself:

```bash
git clone https://github.com/<github-owner>/git-storage.git
cd git-storage
npm ci
npm run build
npm install --global .
git gdrive version
```

Replace `<github-owner>` with the repository owner. A local tarball works too:

```bash
npm ci
npm run verify
npm pack
npm install --global ./git-storage-gdrive-0.1.0.tgz
```

The installation exposes both `git-gdrive` and `git-remote-gdrive`. Git invokes the former as `git gdrive` and discovers the latter automatically for `gdrive://` remotes.

## Google Cloud OAuth setup

1. Create or select a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the Google Auth Platform consent screen. For an External app in Testing, add your Google account as a test user.
4. Create an OAuth client with application type **Desktop app** and download its JSON file.
5. Authenticate locally:

   ```bash
   git gdrive auth login --credentials /path/to/oauth-client.json
   ```

6. Complete the browser consent flow, then verify the setup:

   ```bash
   git gdrive auth status
   git gdrive doctor
   ```

The login uses a loopback callback on `localhost`, requests offline access, and requests only the per-file `https://www.googleapis.com/auth/drive.file` scope. Google’s current setup guidance is in the [Drive API Node.js quickstart](https://developers.google.com/workspace/drive/api/quickstart/nodejs); scope details are in the [Drive authorization guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Create and use a remote

Create an empty Drive-backed remote:

```bash
git gdrive init --name my-project
```

The command prints a canonical URL such as `gdrive://1AbCdEf...`. Add it to an existing repository and push its default branch and tags:

```bash
git remote add backup gdrive://1AbCdEf...
git push -u backup main
git push backup --tags
```

Clone into a fresh directory:

```bash
git clone gdrive://1AbCdEf... restored-project
git -C restored-project fsck --full
```

Fetch and pull later changes normally:

```bash
git fetch backup
git pull --ff-only backup main
```

Branches, lightweight tags, and annotated tags are supported. Normal non-fast-forward branch updates are rejected. After checking the remote state carefully, an explicit Git force operation is supported:

```bash
git push --force-with-lease backup main
```

Delete a remote ref with normal Git syntax:

```bash
git push backup --delete obsolete-branch
```

The first branch published to an empty remote becomes its default branch, so a first push to `trunk` makes a fresh clone check out `trunk`. If the default branch is later deleted, Git Storage selects the lexicographically first remaining branch; deleting the final ref leaves a valid empty remote. Previously uploaded bundles are deliberately retained for recovery.

## Why a Drive HTTPS link is not a Git remote

A URL such as `https://drive.google.com/drive/folders/...` is a browser page, not Git’s smart HTTP protocol. If it is used directly, Git selects its HTTP transport and the Drive page cannot answer Git protocol requests.

Use the canonical URL printed by `git gdrive init`:

```text
gdrive://<drive-folder-id>
```

When importing a folder link manually, prefix it with the explicit helper syntax so Git selects `git-remote-gdrive`:

```bash
git remote add backup 'gdrive::https://drive.google.com/drive/folders/<folder-id>'
```

Some link-shared Drive folders include a resource key. Preserve it when using either accepted URL form:

```bash
git remote add backup 'gdrive://<folder-id>?resourcekey=<resource-key>'
git remote add backup 'gdrive::https://drive.google.com/drive/folders/<folder-id>?resourcekey=<resource-key>'
```

The resource key is used only as request-scoped Drive routing information. It is not written into repository metadata.

## Recovery

Start with a normal independent clone and verify its object database:

```bash
git clone gdrive://<folder-id> recovered
git -C recovered fsck --full
git -C recovered show-ref
```

Each successful push uploads a new complete bundle before publishing new metadata. The previous metadata remains authoritative if upload or verification fails, and superseded bundle objects are not automatically deleted. If the current metadata is damaged, download a known-good earlier `repository.bundle` object from the managed Drive folder, then recover it with Git itself:

```bash
git bundle verify /path/to/repository.bundle
git clone /path/to/repository.bundle recovered-from-bundle
git -C recovered-from-bundle fsck --full
```

Do not hand-edit `repository.json` unless you have separately preserved the whole Drive folder and understand the format. File IDs, not displayed filenames, identify the active metadata and bundle objects.

## Security and local data

Git Storage copies the Desktop OAuth client configuration into a private application config directory and stores its refreshable token there. On Unix-like systems it enforces mode `0700` on the directory and `0600` on stored JSON files. The default locations are:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/git-storage`
- macOS: `~/Library/Application Support/git-storage`
- Windows: `%APPDATA%\\git-storage`

`GIT_GDRIVE_CONFIG_DIR` overrides the location for isolated testing. Treat `oauth-client.json` and especially `token.json` as secrets: do not commit, share, paste, or include them in bug reports. `git gdrive auth logout` removes only the local token; it does not revoke access at Google or delete Drive data.

The helper launches Git with argument arrays and an isolated configuration environment. Downloaded bundles are checked against metadata SHA-256 and verified by Git before objects are imported. Protocol output is kept separate from concise diagnostics so errors do not corrupt Git’s remote-helper stream.

## Doctor and troubleshooting

Run:

```bash
git gdrive doctor
```

It checks Node, Git, OAuth credentials, refreshable authentication, read-only Drive API access, and discovery of both executables.

- **`git: 'gdrive' is not a git command`** — ensure the npm global bin directory is on `PATH`; confirm with `command -v git-gdrive` and `command -v git-remote-gdrive` (or `where` on Windows).
- **Git cannot find the remote helper** — `git-remote-gdrive` must be on the same `PATH` visible to Git. Reopen the shell after changing npm’s global prefix.
- **OAuth credentials are missing or invalid** — download a Desktop app client JSON, not a Web application client, and rerun `auth login` with its exact path.
- **The browser does not open or callback fails** — run login on a machine with a local browser and available loopback port; the flow is not intended for a remote shell without browser access.
- **Authentication worked and later expired** — External OAuth apps left in Google’s Testing publishing status normally receive refresh tokens that expire after seven days. Add the account as a test user and rerun login, or choose the appropriate publishing status for your private project; see Google’s [OAuth expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration).
- **Permission denied** — confirm the same Google account authorized the app and owns the managed folder. The MVP does not implement multi-user sharing or permission repair.
- **Rate limited or temporarily offline** — wait and retry. Drive retryable network, `429`, and server errors use bounded backoff; persistent failures return a stable error without replacing the prior valid metadata.
- **Bundle missing or corrupt** — stop pushing, preserve the Drive folder, try an independent clone, and inspect an earlier retained bundle as described under Recovery.

## MVP limitations

- One user and one writer at a time; no locking or concurrent-push support.
- SHA-1 repositories only.
- Complete bundles are uploaded on each successful push; this is intentionally simple and can be slow for large repositories.
- No shallow clones, partial clones, Git LFS transport, submodule hosting, or advanced server features.
- No web UI, hosted backend, collaboration, pull requests, permissions system, hooks, or CI integration.
- Superseded Drive bundle objects are retained; automatic garbage collection is not included.
- The OAuth flow is interactive and browser-based.

## Local development

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run verify
npm pack --dry-run
```

Committed tests use isolated temporary repositories and a filesystem-backed process seam. They do not read personal Git configuration, OAuth credentials, or live Drive data. A live Drive smoke test is intentionally manual.
