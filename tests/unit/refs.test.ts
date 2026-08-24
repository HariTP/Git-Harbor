import { describe, expect, it } from "vitest";

import { GitStorageError } from "../../src/domain/errors.js";
import {
  createBranchUpdatePolicyInput,
  parsePushRefspec,
  validateObjectId,
} from "../../src/domain/refs.js";

describe("parsePushRefspec", () => {
  it("parses a normal branch update", () => {
    expect(parsePushRefspec("refs/heads/main:refs/heads/main")).toEqual({
      kind: "update",
      source: "refs/heads/main",
      destination: "refs/heads/main",
      force: false,
    });
  });

  it("parses a forced tag update", () => {
    expect(parsePushRefspec("+v1.0.0:refs/tags/v1.0.0")).toEqual({
      kind: "update",
      source: "v1.0.0",
      destination: "refs/tags/v1.0.0",
      force: true,
    });
  });

  it("represents an empty source as a deletion", () => {
    expect(parsePushRefspec(":refs/heads/obsolete")).toEqual({
      kind: "delete",
      source: null,
      destination: "refs/heads/obsolete",
      force: false,
    });
  });

  it("rejects a destination outside remote branches and tags", () => {
    expect(() => parsePushRefspec("HEAD:HEAD")).toThrow(
      expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
    );
  });

  it("rejects Git-invalid components in an otherwise allowed destination namespace", () => {
    expect(() => parsePushRefspec("main:refs/heads/.hidden")).toThrow(
      expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
    );
  });

  it("accepts only 40-character hexadecimal SHA-1 object IDs", () => {
    expect(validateObjectId("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(() => validateObjectId("not-a-sha".repeat(5))).toThrow(
      expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
    );
  });

  it("rejects malformed refspecs and protocol-injecting sources", () => {
    for (const refspec of [
      "refs/heads/main",
      "refs/heads/main:refs/heads/next:extra",
      "refs/heads/main\ncapabilities:refs/heads/main",
    ]) {
      expect(() => parsePushRefspec(refspec)).toThrow(
        expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
      );
    }
  });

  it("rejects whitespace and control bytes in a push source expression", () => {
    for (const refspec of [
      "refs/heads/main bad:refs/heads/main",
      "refs/heads/main\tbad:refs/heads/main",
      "refs/heads/main\u007fbad:refs/heads/main",
    ]) {
      expect(() => parsePushRefspec(refspec)).toThrow(
        expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
      );
    }
  });

  it("exposes validated inputs for later branch fast-forward policy", () => {
    expect(
      createBranchUpdatePolicyInput({
        destination: "refs/heads/main",
        currentObjectId: null,
        nextObjectId: "0123456789abcdef0123456789abcdef01234567",
        nextObjectType: "commit",
        force: false,
      }),
    ).toEqual({
      destination: "refs/heads/main",
      currentObjectId: null,
      nextObjectId: "0123456789abcdef0123456789abcdef01234567",
      nextObjectType: "commit",
      force: false,
    });
  });

  it("rejects a non-commit object proposed for a branch update", () => {
    expect(() =>
      createBranchUpdatePolicyInput({
        destination: "refs/heads/main",
        currentObjectId: null,
        nextObjectId: "0123456789abcdef0123456789abcdef01234567",
        nextObjectType: "tree",
        force: false,
      }),
    ).toThrow(expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }));
  });
});
