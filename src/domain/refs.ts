import { GitStorageError } from "./errors.js";

export type BranchRefName = `refs/heads/${string}`;
export type TagRefName = `refs/tags/${string}`;
export type RemoteRefName = BranchRefName | TagRefName;
export type ObjectId = string & { readonly __objectId: unique symbol };
export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface PushRefspec {
  readonly kind: "update" | "delete";
  readonly source: string | null;
  readonly destination: string;
  readonly force: boolean;
}

export interface BranchUpdatePolicyInput {
  readonly destination: BranchRefName;
  readonly currentObjectId: ObjectId | null;
  readonly nextObjectId: ObjectId;
  readonly nextObjectType: "commit";
  readonly force: boolean;
}

const invalidRef = (): GitStorageError =>
  new GitStorageError("INVALID_REF", "Invalid remote reference.");

export function validateRemoteRef(refname: string): RemoteRefName {
  const isRemoteNamespace =
    refname.startsWith("refs/heads/") || refname.startsWith("refs/tags/");
  const shortName = refname.slice(refname.indexOf("/") + 1);
  const components = shortName.split("/");
  const hasForbiddenCharacter = Array.from(refname).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*\\[]".includes(character);
  });
  const hasInvalidGitRefSyntax =
    refname.length === 0 ||
    hasForbiddenCharacter ||
    refname.includes("..") ||
    refname.includes("@{") ||
    refname.includes("//") ||
    refname.endsWith(".") ||
    components.some(
      (segment) =>
        segment === "" ||
        segment.startsWith(".") ||
        segment === ".." ||
        segment.endsWith(".lock"),
    );

  if (!isRemoteNamespace || hasInvalidGitRefSyntax) {
    throw invalidRef();
  }

  return refname as RemoteRefName;
}

export function validateObjectId(objectId: string): ObjectId {
  if (!/^[0-9a-fA-F]{40}$/.test(objectId)) {
    throw invalidRef();
  }

  return objectId as ObjectId;
}

export function createBranchUpdatePolicyInput(input: {
  readonly destination: string;
  readonly currentObjectId: string | null;
  readonly nextObjectId: string;
  readonly nextObjectType: GitObjectType;
  readonly force: boolean;
}): BranchUpdatePolicyInput {
  const destination = validateRemoteRef(input.destination);

  if (!destination.startsWith("refs/heads/")) {
    throw invalidRef();
  }

  if (input.nextObjectType !== "commit") {
    throw invalidRef();
  }

  return {
    destination: destination as BranchRefName,
    currentObjectId:
      input.currentObjectId === null ? null : validateObjectId(input.currentObjectId),
    nextObjectId: validateObjectId(input.nextObjectId),
    nextObjectType: input.nextObjectType,
    force: input.force,
  };
}

export function parsePushRefspec(refspec: string): PushRefspec {
  if (refspec.includes("\r") || refspec.includes("\n") || refspec.includes("\0")) {
    throw invalidRef();
  }

  const force = refspec.startsWith("+");
  const unforcedRefspec = force ? refspec.slice(1) : refspec;
  const separator = unforcedRefspec.indexOf(":");

  if (separator < 0 || separator !== unforcedRefspec.lastIndexOf(":")) {
    throw invalidRef();
  }

  const source = unforcedRefspec.slice(0, separator);
  const hasUnsafeSourceCharacter = Array.from(source).some((character) => {
    const code = character.charCodeAt(0);
    return character.trim() === "" || code <= 0x1f || code === 0x7f;
  });

  if (hasUnsafeSourceCharacter) {
    throw invalidRef();
  }

  return {
    kind: source === "" ? "delete" : "update",
    source: source === "" ? null : source,
    destination: validateRemoteRef(unforcedRefspec.slice(separator + 1)),
    force,
  };
}
