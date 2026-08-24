import { GitStorageError } from "./errors.js";
import { validateRemoteRef } from "./refs.js";

const sha256Pattern = /^[0-9a-fA-F]{64}$/;
const sha1ObjectIdPattern = /^[0-9a-fA-F]{40}$/;
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export interface RepositoryMetadata {
  readonly formatVersion: 1;
  readonly repositoryId: string;
  readonly displayName: string;
  readonly objectFormat: "sha1";
  readonly defaultBranch: string;
  readonly bundleFileId: string | null;
  readonly bundleSha256: string | null;
  readonly refs: Readonly<Record<string, string>>;
  readonly generation: number;
  readonly updatedAt: string;
  readonly writerId: string;
}

export function parseRepositoryMetadata(value: unknown): RepositoryMetadata {
  if (!isRecord(value)) {
    throw invalidMetadata();
  }

  if (value.formatVersion !== 1) {
    if (typeof value.formatVersion === "number" && Number.isSafeInteger(value.formatVersion)) {
      throw unsupportedMetadataFormat();
    }
    throw invalidMetadata();
  }

  if (
    typeof value.repositoryId !== "string" || !uuidPattern.test(value.repositoryId) ||
    typeof value.displayName !== "string" || value.displayName.trim().length === 0 ||
    value.objectFormat !== "sha1" ||
    typeof value.defaultBranch !== "string" ||
    (value.bundleFileId !== null &&
      (typeof value.bundleFileId !== "string" || value.bundleFileId.trim().length === 0)) ||
    (value.bundleSha256 !== null &&
      (typeof value.bundleSha256 !== "string" || !sha256Pattern.test(value.bundleSha256))) ||
    !isRecord(value.refs) ||
    typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    typeof value.updatedAt !== "string" || !isRfc3339(value.updatedAt) ||
    typeof value.writerId !== "string" || value.writerId.trim().length === 0
  ) {
    throw invalidMetadata();
  }

  if (!isValidDefaultBranch(value.defaultBranch)) {
    throw invalidMetadata();
  }

  const refs: Record<string, string> = {};
  for (const [name, oid] of Object.entries(value.refs)) {
    if (typeof oid !== "string" || !sha1ObjectIdPattern.test(oid)) {
      throw invalidMetadata();
    }
    try {
      refs[validateRemoteRef(name)] = oid;
    } catch {
      throw invalidMetadata();
    }
  }

  if ((value.bundleFileId === null) !== (value.bundleSha256 === null)) {
    throw invalidMetadata();
  }

  const hasBundle = value.bundleFileId !== null;
  const hasRefs = Object.keys(refs).length > 0;
  if (hasBundle !== hasRefs) {
    throw invalidMetadata();
  }

  return {
    formatVersion: 1,
    repositoryId: value.repositoryId,
    displayName: value.displayName,
    objectFormat: "sha1",
    defaultBranch: value.defaultBranch,
    bundleFileId: value.bundleFileId,
    bundleSha256: value.bundleSha256,
    refs,
    generation: value.generation,
    updatedAt: value.updatedAt,
    writerId: value.writerId,
  };
}

export function serializeRepositoryMetadata(metadata: RepositoryMetadata): string {
  const validated = parseRepositoryMetadata(metadata);
  const refs = Object.fromEntries(
    Object.entries(validated.refs).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

  return JSON.stringify({
    formatVersion: validated.formatVersion,
    repositoryId: validated.repositoryId,
    displayName: validated.displayName,
    objectFormat: validated.objectFormat,
    defaultBranch: validated.defaultBranch,
    bundleFileId: validated.bundleFileId,
    bundleSha256: validated.bundleSha256,
    refs,
    generation: validated.generation,
    updatedAt: validated.updatedAt,
    writerId: validated.writerId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDefaultBranch(value: string): boolean {
  try {
    return validateRemoteRef(value).startsWith("refs/heads/");
  } catch {
    return false;
  }
}

function isRfc3339(value: string): boolean {
  const match = rfc3339Pattern.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;

  return day <= daysInMonth;
}

function invalidMetadata(): GitStorageError {
  return new GitStorageError("REMOTE_METADATA_INVALID", "The repository metadata is invalid.");
}

function unsupportedMetadataFormat(): GitStorageError {
  return new GitStorageError(
    "REMOTE_FORMAT_UNSUPPORTED",
    "The repository metadata format is not supported.",
  );
}
