import { GitStorageError, type ErrorCode } from "../domain/errors.js";
import {
  parsePushRefspec,
  validateObjectId,
  validateRemoteRef,
  type BranchRefName,
  type ObjectId,
  type PushRefspec,
  type RemoteRefName,
} from "../domain/refs.js";

export type ProtocolCommand =
  | { readonly kind: "capabilities" }
  | { readonly kind: "option"; readonly name: string; readonly value: string }
  | { readonly kind: "list"; readonly forPush: boolean }
  | {
      readonly kind: "fetch";
      readonly objectId: ObjectId;
      readonly refname: RemoteRefName;
    }
  | { readonly kind: "push"; readonly update: PushRefspec };

export interface AdvertisedRef {
  readonly name: RemoteRefName;
  readonly objectId: string;
}

export type PushResult =
  | { readonly destination: RemoteRefName; readonly ok: true }
  | { readonly destination: RemoteRefName; readonly ok: false; readonly reason: string };

export interface ProtocolFatalDiagnostic {
  readonly code: ErrorCode;
  readonly message: string;
}

export function serializeCapabilities(): string {
  return "fetch\npush\noption\n\n";
}

export function serializeOptionResponse(supported: boolean): string {
  return supported ? "ok\n" : "unsupported\n";
}

export function serializeAdvertisedRefs(
  refs: readonly AdvertisedRef[],
  defaultBranch: BranchRefName,
): string {
  const validatedDefaultBranch = validateRemoteRef(defaultBranch);
  if (!validatedDefaultBranch.startsWith("refs/heads/")) {
    throw new GitStorageError("INVALID_REF", "Default branch must be a branch reference.");
  }

  const lines = refs.map((ref) => {
    const objectId = validateObjectId(ref.objectId);
    const refname = validateRemoteRef(ref.name);
    return `${objectId} ${refname}`;
  });

  lines.push(`@${validatedDefaultBranch} HEAD`);
  return `${lines.join("\n")}\n\n`;
}

export function parseProtocolBatches(input: string): ProtocolCommand[][] {
  const batches: ProtocolCommand[][] = [];
  let currentBatch: ProtocolCommand[] = [];

  for (const line of input.split(/\r?\n/)) {
    if (line === "") {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      continue;
    }

    currentBatch.push(parseProtocolLine(line));
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function serializePushResults(results: readonly PushResult[]): string {
  const lines = results.map((result) => {
    const destination = validateRemoteRef(result.destination);
    if (result.ok) {
      return `ok ${destination}`;
    }

    return `error ${destination} ${safeProtocolText(result.reason)}`;
  });

  return `${lines.join("\n")}\n\n`;
}

export function toProtocolFatalDiagnostic(error: unknown): ProtocolFatalDiagnostic {
  if (error instanceof GitStorageError) {
    return { code: error.code, message: safeProtocolText(error.message) };
  }

  return { code: "INTERNAL_ERROR", message: "Remote helper failed." };
}

function safeProtocolText(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  return sanitized === "" ? "operation failed" : sanitized;
}

export function parseProtocolLine(line: string): ProtocolCommand {
  if (line.includes("\r") || line.includes("\n") || line.includes("\0")) {
    throw invalidProtocolCommand();
  }

  if (line === "capabilities") {
    return { kind: "capabilities" };
  }

  if (line === "list" || line === "list for-push") {
    return { kind: "list", forPush: line === "list for-push" };
  }

  const fetchMatch = /^fetch ([^\s]+) ([^\s]+)$/.exec(line);
  if (fetchMatch !== null) {
    return {
      kind: "fetch",
      objectId: validateObjectId(fetchMatch[1]),
      refname: validateRemoteRef(fetchMatch[2]),
    };
  }

  const pushMatch = /^push (.+)$/.exec(line);
  if (pushMatch !== null) {
    return { kind: "push", update: parsePushRefspec(pushMatch[1]) };
  }

  const optionMatch = /^option ([^\s]+) (.+)$/.exec(line);
  if (optionMatch !== null) {
    return { kind: "option", name: optionMatch[1], value: optionMatch[2] };
  }

  throw invalidProtocolCommand();
}

function invalidProtocolCommand(): GitStorageError {
  return new GitStorageError("INVALID_REF", "Invalid remote-helper command.");
}
