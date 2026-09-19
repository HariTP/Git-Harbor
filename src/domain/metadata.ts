import { GitStorageError } from "./errors.js";
import { validateObjectId, validateRemoteRef } from "./refs.js";

const sha256Pattern = /^[0-9a-fA-F]{64}$/;
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export type ArtifactKind = "base" | "incremental";

export interface ArtifactDescriptor {
  readonly id: string;
  readonly storageKey: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly size: number;
  readonly prerequisites: readonly string[];
  readonly heads: Readonly<Record<string, string>>;
}

export interface RepositoryMetadata {
  readonly formatVersion: 2;
  readonly repositoryId: string;
  readonly displayName: string;
  readonly objectFormat: "sha1";
  readonly defaultBranch: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly generation: number;
  readonly updatedAt: string;
  readonly writerId: string;
}

export function parseRepositoryMetadata(value: unknown): RepositoryMetadata {
  if (!isRecord(value)) {
    throw invalidMetadata();
  }

  if (value.formatVersion !== 2) {
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
    !isRecord(value.refs) ||
    !Array.isArray(value.artifacts) ||
    typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    typeof value.updatedAt !== "string" || !isRfc3339(value.updatedAt) ||
    typeof value.writerId !== "string" || value.writerId.trim().length === 0
  ) {
    throw invalidMetadata();
  }

  if (!isValidDefaultBranch(value.defaultBranch)) {
    throw invalidMetadata();
  }

  const refs = parseRefs(value.refs);
  const artifacts = value.artifacts.map(parseArtifact);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const storageKeys = new Set(artifacts.map((artifact) => artifact.storageKey));
  if (artifactIds.size !== artifacts.length || storageKeys.size !== artifacts.length) {
    throw invalidMetadata();
  }
  if (Object.keys(refs).length > 0 && artifacts.length === 0) {
    throw invalidMetadata();
  }

  return {
    formatVersion: 2,
    repositoryId: value.repositoryId,
    displayName: value.displayName,
    objectFormat: "sha1",
    defaultBranch: value.defaultBranch,
    refs,
    artifacts,
    generation: value.generation,
    updatedAt: value.updatedAt,
    writerId: value.writerId,
  };
}

export function serializeRepositoryMetadata(metadata: RepositoryMetadata): string {
  const validated = parseRepositoryMetadata(metadata);
  return JSON.stringify({
    ...validated,
    refs: sortRecord(validated.refs),
    artifacts: validated.artifacts.map((artifact) => ({
      ...artifact,
      prerequisites: [...artifact.prerequisites],
      heads: sortRecord(artifact.heads),
    })),
  });
}

function parseArtifact(value: unknown): ArtifactDescriptor {
  if (!isRecord(value) ||
    typeof value.id !== "string" || value.id.trim().length === 0 ||
    typeof value.storageKey !== "string" || value.storageKey.trim().length === 0 ||
    (value.kind !== "base" && value.kind !== "incremental") ||
    typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256) ||
    typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
    !Array.isArray(value.prerequisites) || !isRecord(value.heads)) {
    throw invalidMetadata();
  }
  const prerequisites = value.prerequisites.map((oid) => {
    if (typeof oid !== "string") {
      throw invalidMetadata();
    }
    try {
      return validateObjectId(oid);
    } catch {
      throw invalidMetadata();
    }
  });
  if (new Set(prerequisites).size !== prerequisites.length) {
    throw invalidMetadata();
  }
  const heads = parseRefs(value.heads);
  if (Object.keys(heads).length === 0) {
    throw invalidMetadata();
  }
  if (value.kind === "base" && prerequisites.length > 0) {
    throw invalidMetadata();
  }
  return {
    id: value.id,
    storageKey: value.storageKey,
    kind: value.kind,
    sha256: value.sha256.toLowerCase(),
    size: value.size,
    prerequisites,
    heads,
  };
}

function parseRefs(value: Record<string, unknown>): Readonly<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [name, oid] of Object.entries(value)) {
    if (typeof oid !== "string") {
      throw invalidMetadata();
    }
    try {
      refs[validateRemoteRef(name)] = validateObjectId(oid);
    } catch {
      throw invalidMetadata();
    }
  }
  return refs;
}

function sortRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
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
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth;
}

function invalidMetadata(): GitStorageError {
  return new GitStorageError("REMOTE_METADATA_INVALID", "The repository metadata is invalid.");
}

function unsupportedMetadataFormat(): GitStorageError {
  return new GitStorageError("REMOTE_FORMAT_UNSUPPORTED", "The repository metadata format is not supported.");
}
