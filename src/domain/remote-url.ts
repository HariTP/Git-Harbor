import { GitStorageError } from "./errors.js";

export interface ParsedRemoteUrl {
  readonly folderId: string;
  readonly resourceKey: string | null;
  readonly canonicalUrl: string;
  readonly normalizedUrl: string;
}

const folderIdPattern = /^[A-Za-z0-9_-]+$/;
const resourceKeyPattern = /^[A-Za-z0-9_-]+$/;

export function parseRemoteUrl(input: string): ParsedRemoteUrl {
  const isExplicitHelperSyntax = input.startsWith("gdrive::");
  const url = parseUrl(isExplicitHelperSyntax ? input.slice("gdrive::".length) : input);

  if (isExplicitHelperSyntax) {
    if (url.protocol !== "https:" || url.hostname !== "drive.google.com") {
      throw invalidRemoteUrl();
    }
    return parseDriveFolderLink(url);
  }

  if (url.protocol === "gdrive:") {
    return parseCanonicalUrl(url);
  }

  if (url.protocol === "https:" && url.hostname === "drive.google.com") {
    return parseDriveFolderLink(url);
  }

  throw invalidRemoteUrl();
}

function parseCanonicalUrl(url: URL): ParsedRemoteUrl {
  if (url.username || url.password || url.port) {
    throw invalidRemoteUrl();
  }

  const folderId = url.hostname;
  if (!folderId || url.pathname !== "" || !folderIdPattern.test(folderId)) {
    throw invalidRemoteUrl();
  }

  return makeParsedRemoteUrl(folderId, parseResourceKey(url));
}

function parseDriveFolderLink(url: URL): ParsedRemoteUrl {
  const pathParts = url.pathname.split("/").filter(Boolean);
  const folderId =
    pathParts.length === 3 && pathParts[0] === "drive" && pathParts[1] === "folders"
      ? pathParts[2]
      : pathParts.length === 5 &&
          pathParts[0] === "drive" &&
          pathParts[1] === "u" &&
          /^\d+$/.test(pathParts[2]) &&
          pathParts[3] === "folders"
        ? pathParts[4]
      : null;

  if (!folderId || !folderIdPattern.test(folderId)) {
    throw invalidRemoteUrl();
  }

  return makeParsedRemoteUrl(folderId, parseResourceKey(url));
}

function parseUrl(input: string): URL {
  if (typeof input !== "string" || input.trim() !== input || input.length === 0) {
    throw invalidRemoteUrl();
  }

  try {
    return new URL(input);
  } catch {
    throw invalidRemoteUrl();
  }
}

function makeParsedRemoteUrl(folderId: string, resourceKey: string | null): ParsedRemoteUrl {
  const canonicalUrl = `gdrive://${folderId}`;
  return {
    folderId,
    resourceKey,
    canonicalUrl,
    normalizedUrl:
      resourceKey === null ? canonicalUrl : `${canonicalUrl}?resourcekey=${encodeURIComponent(resourceKey)}`,
  };
}

function parseResourceKey(url: URL): string | null {
  if (url.hash) {
    throw invalidRemoteUrl();
  }

  const parameters = [...url.searchParams.entries()];
  if (parameters.length === 0) {
    return null;
  }

  if (parameters.length !== 1 || parameters[0][0] !== "resourcekey") {
    throw invalidRemoteUrl();
  }

  const resourceKey = parameters[0][1];
  if (!resourceKeyPattern.test(resourceKey)) {
    throw invalidRemoteUrl();
  }

  return resourceKey;
}

function invalidRemoteUrl(): GitStorageError {
  return new GitStorageError("REMOTE_URL_INVALID", "The Drive remote URL is invalid.");
}
