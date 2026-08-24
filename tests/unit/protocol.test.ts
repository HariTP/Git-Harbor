import { describe, expect, it } from "vitest";

import { GitStorageError } from "../../src/domain/errors.js";
import {
  parseProtocolLine,
  parseProtocolBatches,
  serializeAdvertisedRefs,
  serializeCapabilities,
  serializeOptionResponse,
  serializePushResults,
  toProtocolFatalDiagnostic,
} from "../../src/remote-helper/protocol.js";

describe("remote-helper protocol", () => {
  it("serializes only the supported capabilities with protocol framing", () => {
    expect(serializeCapabilities()).toBe("fetch\npush\noption\n\n");
  });

  it("parses the capabilities command", () => {
    expect(parseProtocolLine("capabilities")).toEqual({ kind: "capabilities" });
  });

  it("parses options and serializes Git's supported and unsupported replies", () => {
    expect(parseProtocolLine("option progress true")).toEqual({
      kind: "option",
      name: "progress",
      value: "true",
    });
    expect(serializeOptionResponse(true)).toBe("ok\n");
    expect(serializeOptionResponse(false)).toBe("unsupported\n");
  });

  it("parses list variants and advertises the default branch as HEAD", () => {
    expect(parseProtocolLine("list")).toEqual({ kind: "list", forPush: false });
    expect(parseProtocolLine("list for-push")).toEqual({ kind: "list", forPush: true });
    expect(
      serializeAdvertisedRefs(
        [
          {
            name: "refs/heads/main",
            objectId: "0123456789abcdef0123456789abcdef01234567",
          },
        ],
        "refs/heads/main",
      ),
    ).toBe(
      "0123456789abcdef0123456789abcdef01234567 refs/heads/main\n@refs/heads/main HEAD\n\n",
    );
  });

  it("rejects a tag configured as the default branch with a stable ref error", () => {
    expect(() => serializeAdvertisedRefs([], "refs/tags/v1" as never)).toThrow(
      expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
    );
  });

  it("parses a fetch request with a SHA-1 and remote ref", () => {
    expect(
      parseProtocolLine(
        "fetch 0123456789abcdef0123456789abcdef01234567 refs/tags/v1.0.0",
      ),
    ).toEqual({
      kind: "fetch",
      objectId: "0123456789abcdef0123456789abcdef01234567",
      refname: "refs/tags/v1.0.0",
    });
  });

  it("parses a forced push request", () => {
    expect(
      parseProtocolLine("push +refs/heads/main:refs/heads/main"),
    ).toEqual({
      kind: "push",
      update: {
        kind: "update",
        source: "refs/heads/main",
        destination: "refs/heads/main",
        force: true,
      },
    });
  });

  it("accumulates CRLF-delimited fetch and push batches through blank terminators", () => {
    expect(
      parseProtocolBatches(
        "fetch 0123456789abcdef0123456789abcdef01234567 refs/heads/main\r\n" +
          "fetch 89abcdef0123456789abcdef0123456789abcdef refs/tags/v1\r\n\r\n" +
          "push :refs/heads/obsolete\r\n\r\n",
      ),
    ).toEqual([
      [
        {
          kind: "fetch",
          objectId: "0123456789abcdef0123456789abcdef01234567",
          refname: "refs/heads/main",
        },
        {
          kind: "fetch",
          objectId: "89abcdef0123456789abcdef0123456789abcdef",
          refname: "refs/tags/v1",
        },
      ],
      [
        {
          kind: "push",
          update: {
            kind: "delete",
            source: null,
            destination: "refs/heads/obsolete",
            force: false,
          },
        },
      ],
    ]);
  });

  it("serializes one safe status line per push result and a terminal blank line", () => {
    expect(
      serializePushResults([
        { destination: "refs/heads/main", ok: true },
        {
          destination: "refs/tags/v1",
          ok: false,
          reason: "rejected\nnot-fast-forward",
        },
      ]),
    ).toBe(
      "ok refs/heads/main\nerror refs/tags/v1 rejected not-fast-forward\n\n",
    );
  });

  it("rejects malformed protocol input with a stable, non-injectable error", () => {
    try {
      parseProtocolLine("push refs/heads/main\ncapabilities:refs/heads/main");
      throw new Error("expected malformed command to throw");
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining<Partial<GitStorageError>>({ code: "INVALID_REF" }),
      );
      expect((error as Error).message).not.toMatch(/[\r\n]/);
    }
  });

  it("models fatal diagnostics separately from protocol stdout", () => {
    expect(
      toProtocolFatalDiagnostic(
        new GitStorageError("INVALID_REF", "invalid destination\nrefs/heads/main"),
      ),
    ).toEqual({ code: "INVALID_REF", message: "invalid destination refs/heads/main" });
  });
});
