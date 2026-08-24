import { describe, expect, test } from "vitest";

import { parseRemoteUrl } from "../../src/domain/remote-url.js";

describe("parseRemoteUrl", () => {
  test("normalizes a canonical Drive remote URL", () => {
    expect(parseRemoteUrl("gdrive://1AbCdEf_234")).toEqual({
      folderId: "1AbCdEf_234",
      resourceKey: null,
      canonicalUrl: "gdrive://1AbCdEf_234",
      normalizedUrl: "gdrive://1AbCdEf_234",
    });
  });

  test("normalizes a Drive folder link", () => {
    expect(
      parseRemoteUrl("https://drive.google.com/drive/folders/1AbCdEf_234"),
    ).toMatchObject({
      folderId: "1AbCdEf_234",
      canonicalUrl: "gdrive://1AbCdEf_234",
      normalizedUrl: "gdrive://1AbCdEf_234",
    });
  });

  test("normalizes an account-indexed Drive folder link", () => {
    expect(
      parseRemoteUrl("https://drive.google.com/drive/u/3/folders/1AbCdEf_234"),
    ).toMatchObject({
      folderId: "1AbCdEf_234",
      canonicalUrl: "gdrive://1AbCdEf_234",
    });
  });

  test("normalizes explicit helper syntax", () => {
    expect(
      parseRemoteUrl("gdrive::https://drive.google.com/drive/folders/1AbCdEf_234"),
    ).toMatchObject({
      folderId: "1AbCdEf_234",
      normalizedUrl: "gdrive://1AbCdEf_234",
    });
  });

  test("preserves a Drive resource key in the normalized URL", () => {
    expect(
      parseRemoteUrl(
        "https://drive.google.com/drive/folders/1AbCdEf_234?resourcekey=0-abc_DEF",
      ),
    ).toEqual({
      folderId: "1AbCdEf_234",
      resourceKey: "0-abc_DEF",
      canonicalUrl: "gdrive://1AbCdEf_234",
      normalizedUrl: "gdrive://1AbCdEf_234?resourcekey=0-abc_DEF",
    });
  });

  test("rejects an empty remote URL with a stable error", () => {
    expect(() => parseRemoteUrl("")).toThrowError(
      expect.objectContaining({
        code: "REMOTE_URL_INVALID",
        message: "The Drive remote URL is invalid.",
      }),
    );
  });

  test("rejects helper syntax whose payload is not a Drive folder link", () => {
    expect(() => parseRemoteUrl("gdrive::gdrive://1AbCdEf_234")).toThrowError(
      expect.objectContaining({ code: "REMOTE_URL_INVALID" }),
    );
  });

  test.each([
    "gdrive://",
    "gdrive://1AbCdEf_234/extra",
    "gdrive://1AbCdEf_234?unexpected=value",
    "https://example.com/drive/folders/1AbCdEf_234",
    "https://drive.google.com/drive/folders/",
  ])("rejects malformed or unsupported URL %s", (input) => {
    expect(() => parseRemoteUrl(input)).toThrowError(
      expect.objectContaining({ code: "REMOTE_URL_INVALID" }),
    );
  });
});
