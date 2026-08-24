import { describe, expect, test } from "vitest";

import {
  parseRepositoryMetadata,
  serializeRepositoryMetadata,
} from "../../src/domain/metadata.js";

describe("parseRepositoryMetadata", () => {
  test("accepts a valid empty SHA-1 repository", () => {
    expect(
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toEqual({
      formatVersion: 1,
      repositoryId: "123e4567-e89b-12d3-a456-426614174000",
      displayName: "my-repository",
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      bundleFileId: null,
      bundleSha256: null,
      refs: {},
      generation: 1,
      updatedAt: "2026-08-23T12:00:00Z",
      writerId: "a-local-installation",
    });
  });

  test("accepts a populated repository with branch and tag refs", () => {
    expect(
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        refs: {
          "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
          "refs/tags/v1.0.0": "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
        },
        generation: 2,
        updatedAt: "2026-08-23T12:00:00+05:30",
        writerId: "a-local-installation",
      }),
    ).toMatchObject({
      bundleFileId: "1A2b3C4d",
      refs: {
        "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
        "refs/tags/v1.0.0": "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
      },
      generation: 2,
    });
  });

  test("rejects an unknown metadata format version", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 2,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_FORMAT_UNSUPPORTED",
        message: "The repository metadata format is not supported.",
      }),
    );
  });

  test("rejects a populated repository with a non-SHA-256 checksum", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256: "not-a-sha256",
        refs: {
          "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
        },
        generation: 2,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects refs without a published bundle", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {
          "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
        },
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a partial bundle descriptor", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects an empty published bundle ID", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "",
        bundleSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        refs: {
          "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
        },
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a repository ID that is not UUID-shaped", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "my-repository",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a default branch outside refs/heads", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/tags/v1.0.0",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a ref map entry outside refs/heads and refs/tags", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        refs: {
          main: "0123456789abcdef0123456789abcdef01234567",
        },
        generation: 2,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects Git-invalid ref components in a remote namespace", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        refs: {
          "refs/heads/.hidden": "0123456789abcdef0123456789abcdef01234567",
        },
        generation: 2,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a ref map entry without a SHA-1 object ID", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: "1A2b3C4d",
        bundleSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        refs: {
          "refs/heads/main": "not-an-object-id",
        },
        generation: 2,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a timestamp outside RFC3339", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "yesterday afternoon",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects an empty display name", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects an object format other than sha1", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha256",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects a non-positive metadata generation", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 0,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects an empty writer ID", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/main",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects an incomplete default branch ref", () => {
    expect(() =>
      parseRepositoryMetadata({
        formatVersion: 1,
        repositoryId: "123e4567-e89b-12d3-a456-426614174000",
        displayName: "my-repository",
        objectFormat: "sha1",
        defaultBranch: "refs/heads/",
        bundleFileId: null,
        bundleSha256: null,
        refs: {},
        generation: 1,
        updatedAt: "2026-08-23T12:00:00Z",
        writerId: "a-local-installation",
      }),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("serializes metadata deterministically and round-trips it", () => {
    const metadata = parseRepositoryMetadata({
      formatVersion: 1,
      repositoryId: "123e4567-e89b-12d3-a456-426614174000",
      displayName: "my-repository",
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      bundleFileId: "1A2b3C4d",
      bundleSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      refs: {
        "refs/tags/v1.0.0": "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
        "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
      },
      generation: 2,
      updatedAt: "2026-08-23T12:00:00Z",
      writerId: "a-local-installation",
    });

    const serialized = serializeRepositoryMetadata(metadata);

    expect(serialized).toBe(
      '{"formatVersion":1,"repositoryId":"123e4567-e89b-12d3-a456-426614174000","displayName":"my-repository","objectFormat":"sha1","defaultBranch":"refs/heads/main","bundleFileId":"1A2b3C4d","bundleSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","refs":{"refs/heads/main":"0123456789abcdef0123456789abcdef01234567","refs/tags/v1.0.0":"89ABCDEF0123456789ABCDEF0123456789ABCDEF"},"generation":2,"updatedAt":"2026-08-23T12:00:00Z","writerId":"a-local-installation"}',
    );
    expect(parseRepositoryMetadata(JSON.parse(serialized))).toEqual(metadata);
  });

  test("does not retain mutable refs from the source document", () => {
    const document = {
      formatVersion: 1,
      repositoryId: "123e4567-e89b-12d3-a456-426614174000",
      displayName: "my-repository",
      objectFormat: "sha1",
      defaultBranch: "refs/heads/main",
      bundleFileId: "1A2b3C4d",
      bundleSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      refs: { "refs/heads/main": "0123456789abcdef0123456789abcdef01234567" },
      generation: 2,
      updatedAt: "2026-08-23T12:00:00Z",
      writerId: "a-local-installation",
    };

    const metadata = parseRepositoryMetadata(document);
    document.refs["refs/heads/main"] = "89abcdef0123456789abcdef0123456789abcdef";

    expect(metadata.refs["refs/heads/main"]).toBe("0123456789abcdef0123456789abcdef01234567");
  });
});
