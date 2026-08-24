# Mission

## What we are building

Git Storage is a fun side project that explores one simple idea:

> Can a personal Google Drive folder behave like a Git remote?

The project will provide a small command-line tool that translates normal Git remote operations into Google Drive storage operations. A user should be able to initialize a remote in their own Drive, push a repository into it, and later clone or fetch that repository using familiar Git commands.

The intended experience is roughly:

```bash
git gdrive init --name my-project
git remote add backup gdrive://<folder-id>
git push backup main
git clone gdrive://<folder-id> restored-project
```

Google Drive is only the storage backend. Git remains responsible for commits, branches, tags, merges, rebases, history, integrity, and local repository behavior.

## Why we are building it

This project exists to validate a technically playful idea, learn how Git remote helpers work, and produce something interesting enough to demonstrate and share.

It is not a startup, commercial product, or attempt to replace GitHub, GitLab, Bitbucket, or a real Git server. It does not need enterprise architecture, perfect scalability, broad platform integrations, or a monetization strategy.

The project is successful if one person can reliably use their own Google Drive as a secondary Git remote and restore their repository from it.

## The user we support

The MVP supports one user operating on their own Google Drive account.

We assume:

- One person owns and controls the Drive folder.
- That person installs the CLI on their machines.
- Pushes are not performed concurrently.
- The Drive remote is primarily a backup or secondary copy.
- GitHub or another Git remote may remain the primary collaborative origin.
- The user understands that this is experimental software.

Single-user workflows across multiple personal machines are acceptable as long as the user avoids simultaneous pushes.

## What “working” means

The MVP is working when a single user can:

- Authenticate with their own Google Drive account.
- Create a Drive-backed Git remote.
- Push branches and tags using Git.
- Clone the repository into a fresh local directory.
- Fetch and pull later changes.
- Perform merges and rebases locally and push the resulting history.
- Verify that restored repositories retain the expected commits, refs, tags, files, and object integrity.
- Use the remote as a practical backup without manually uploading archive files.

Correctness and recoverability matter more than storage efficiency or speed.

## Non-goals

The following are deliberately outside the mission:

- Multi-user collaboration.
- Simultaneous or concurrent writers.
- Pull requests, reviews, issues, discussions, or project management.
- Branch protection or organization-level permissions.
- Server-side hooks, CI/CD, webhooks, or hosted automation.
- A web interface.
- A hosted backend operated by us.
- Replacing GitHub or another Git forge.
- Enterprise support, service-level guarantees, or high availability.
- Large-scale repository hosting or content distribution.
- Optimizing for very large monorepos.
- Anonymous public hosting.
- Billing, subscriptions, analytics, or monetization.
- Supporting every advanced Git transport feature in the first version.

If a proposed feature mainly helps teams collaborate, scale the system, or turn it into a hosted product, it is probably outside this project's mission.

## Design principles

### Keep Git in charge

Use Git's own commands and formats for repository operations. Do not recreate Git history logic in application code.

### Treat Drive as storage

Google Drive stores repository bundles and metadata. It is not expected to behave like a transactional Git server.

### Optimize for one careful user

Do not add distributed locking, coordination servers, or team permission systems to solve problems the MVP does not claim to support.

### Prefer a complete backup over a clever protocol

A simple, verifiable full-repository bundle is better than an intricate incremental format that is difficult to recover.

### Make failure understandable

The tool should fail safely, preserve the previous valid backup when practical, and clearly explain authentication, Drive, Git, and corruption errors.

### Keep it enjoyable

The code should be approachable, testable, and interesting to work on. Avoid turning a playful experiment into unnecessary infrastructure.

## Scope test

Before adding work, ask:

1. Does this help one user back up or restore a Git repository through Google Drive?
2. Is it required for normal push, clone, fetch, pull, branch, or tag behavior?
3. Does it improve correctness, recoverability, security, installation, or clarity for that user?

If the answer to all three is no, the work should probably not be part of the MVP.

## Final statement

Our mission is to build a small, reliable, and amusing proof of concept that lets one person use their own Google Drive as a backup Git remote through familiar Git commands—and nothing more.

