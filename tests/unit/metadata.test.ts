import { describe, expect, test } from "vitest";

import { parseRepositoryMetadata, serializeRepositoryMetadata } from "../../src/domain/metadata.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const checksum = "a".repeat(64);

function emptyMetadata(): Record<string, unknown> {
  return {
    formatVersion: 2,
    repositoryId: "123e4567-e89b-12d3-a456-426614174000",
    displayName: "my-repository",
    objectFormat: "sha1",
    defaultBranch: "refs/heads/main",
    refs: {},
    artifacts: [],
    generation: 1,
    updatedAt: "2026-08-23T12:00:00Z",
    writerId: "a-local-installation",
  };
}

function artifact(): Record<string, unknown> {
  return {
    id: "artifact-1",
    storageKey: "provider-object-1",
    kind: "base",
    sha256: checksum,
    size: 123,
    prerequisites: [],
    heads: { "refs/heads/main": oid },
  };
}

describe("parseRepositoryMetadata", () => {
  test("accepts empty and populated format-v2 repositories", () => {
    expect(parseRepositoryMetadata(emptyMetadata())).toMatchObject({ formatVersion: 2, artifacts: [], refs: {} });
    expect(parseRepositoryMetadata({
      ...emptyMetadata(),
      refs: { "refs/heads/main": oid },
      artifacts: [artifact()],
      generation: 2,
    })).toMatchObject({
      refs: { "refs/heads/main": oid },
      artifacts: [{ id: "artifact-1", kind: "base" }],
    });
  });

  test("rejects v1 and unknown formats", () => {
    expect(() => parseRepositoryMetadata({ ...emptyMetadata(), formatVersion: 1 }))
      .toThrowError(expect.objectContaining({ code: "REMOTE_FORMAT_UNSUPPORTED" }));
    expect(() => parseRepositoryMetadata({ ...emptyMetadata(), formatVersion: 3 }))
      .toThrowError(expect.objectContaining({ code: "REMOTE_FORMAT_UNSUPPORTED" }));
  });

  test("requires artifacts when refs are advertised", () => {
    expect(() => parseRepositoryMetadata({
      ...emptyMetadata(),
      refs: { "refs/heads/main": oid },
    })).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("validates artifact IDs, keys, checksums, prerequisites, heads, and uniqueness", () => {
    for (const changed of [
      { id: "" },
      { storageKey: "" },
      { sha256: "bad" },
      { size: -1 },
      { prerequisites: ["bad"] },
      { heads: {} },
      { kind: "unknown" },
    ]) {
      expect(() => parseRepositoryMetadata({
        ...emptyMetadata(),
        refs: { "refs/heads/main": oid },
        artifacts: [{ ...artifact(), ...changed }],
      })).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
    }
    expect(() => parseRepositoryMetadata({
      ...emptyMetadata(),
      refs: { "refs/heads/main": oid },
      artifacts: [artifact(), artifact()],
    })).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("rejects prerequisites on a base artifact", () => {
    expect(() => parseRepositoryMetadata({
      ...emptyMetadata(),
      refs: { "refs/heads/main": oid },
      artifacts: [{ ...artifact(), prerequisites: [oid] }],
    })).toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
  });

  test("validates repository identity, refs, timestamp, generation, and writer", () => {
    for (const changed of [
      { repositoryId: "bad" },
      { defaultBranch: "refs/tags/main" },
      { refs: { "refs/remotes/main": oid } },
      { updatedAt: "not-a-time" },
      { generation: 0 },
      { writerId: "" },
      { objectFormat: "sha256" },
    ]) {
      expect(() => parseRepositoryMetadata({ ...emptyMetadata(), ...changed }))
        .toThrowError(expect.objectContaining({ code: "REMOTE_METADATA_INVALID" }));
    }
  });

  test("serializes deterministically and does not retain mutable inputs", () => {
    const source = {
      ...emptyMetadata(),
      refs: { "refs/tags/v1": oid, "refs/heads/main": oid },
      artifacts: [{
        ...artifact(),
        heads: { "refs/tags/v1": oid, "refs/heads/main": oid },
      }],
    };
    const parsed = parseRepositoryMetadata(source);
    (source.refs as Record<string, string>)["refs/heads/main"] = "f".repeat(40);
    expect(parsed.refs["refs/heads/main"]).toBe(oid);
    expect(parseRepositoryMetadata(JSON.parse(serializeRepositoryMetadata(parsed)))).toEqual(parsed);
    expect(serializeRepositoryMetadata(parsed)).toContain('"refs":{"refs/heads/main"');
  });
});
