import { createInterface } from "node:readline";

import type { GitStorageApplication } from "../application/git-storage-application.js";
import { toProtocolFatalDiagnostic, parseProtocolLine, serializeAdvertisedRefs, serializeCapabilities, serializeOptionResponse, serializePushResults, type ProtocolCommand } from "./protocol.js";

const reportedFatalErrors = new WeakSet<object>();

/** Lets the executable avoid printing a protocol diagnostic twice on fatal exit. */
export function hasRemoteHelperDiagnostic(error: unknown): boolean {
  return typeof error === "object" && error !== null && reportedFatalErrors.has(error);
}

export interface RemoteHelperSessionOptions {
  readonly application: Pick<GitStorageApplication, "listRemote" | "fetch" | "push">;
  readonly remoteId: string;
  readonly resourceKey?: string;
  readonly gitDirectory: string;
  readonly stderr?: Pick<NodeJS.WritableStream, "write">;
}

type PendingBatch =
  | { readonly kind: "fetch"; readonly commands: readonly Extract<ProtocolCommand, { readonly kind: "fetch" }>[] }
  | { readonly kind: "push"; readonly commands: readonly Extract<ProtocolCommand, { readonly kind: "push" }>[] };

/**
 * Translates Git's line-oriented remote-helper protocol to the application seam.
 * Commands are consumed as they arrive; Git does not need to close stdin before a
 * capability, list, fetch, or push exchange can complete.
 */
export class RemoteHelperSession {
  private readonly application: RemoteHelperSessionOptions["application"];
  private readonly remoteId: string;
  private readonly resourceKey: string | undefined;
  private readonly gitDirectory: string;
  private readonly stderr: Pick<NodeJS.WritableStream, "write">;

  constructor(options: RemoteHelperSessionOptions) {
    this.application = options.application;
    this.remoteId = options.remoteId;
    this.resourceKey = options.resourceKey;
    this.gitDirectory = options.gitDirectory;
    this.stderr = options.stderr ?? process.stderr;
  }

  async run(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    let pending: PendingBatch | undefined;
    const lines = createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      if (line === "") {
        pending = await this.flush(pending, output);
        continue;
      }

      let command: ProtocolCommand;
      try {
        command = parseProtocolLine(line);
      } catch (error) {
        this.writeFatal(error);
        this.write(output, "\n");
        throw error;
      }

      if (command.kind === "fetch" || command.kind === "push") {
        if (pending !== undefined && pending.kind !== command.kind) {
          const error = new Error("Mixed remote-helper batches are unsupported.");
          this.writeFatal(error);
          this.write(output, "\n");
          throw error;
        }
        pending = command.kind === "fetch"
          ? {
              kind: "fetch",
              commands: [...(pending?.kind === "fetch" ? pending.commands : []), command],
            }
          : {
              kind: "push",
              commands: [...(pending?.kind === "push" ? pending.commands : []), command],
            };
        continue;
      }

      if (pending !== undefined) {
        pending = await this.flush(pending, output);
      }
      await this.runImmediate(command, output);
    }

    await this.flush(pending, output);
  }

  private async runImmediate(
    command: Exclude<ProtocolCommand, { readonly kind: "fetch" | "push" }>,
    output: NodeJS.WritableStream,
  ): Promise<void> {
    try {
      switch (command.kind) {
        case "capabilities":
          this.write(output, serializeCapabilities());
          return;
        case "option":
          this.write(output, serializeOptionResponse(false));
          return;
        case "list": {
          const remote = await this.application.listRemote(this.remoteId, this.resourceKey);
          this.write(output, serializeAdvertisedRefs(remote.refs, remote.defaultBranch));
          return;
        }
      }
    } catch (error) {
      this.writeFatal(error);
      this.write(output, "\n");
      throw error;
    }
  }

  private async flush(pending: PendingBatch | undefined, output: NodeJS.WritableStream): Promise<undefined> {
    if (pending === undefined) {
      return undefined;
    }

    try {
      if (pending.kind === "fetch") {
        await this.application.fetch({
          remoteId: this.remoteId,
          resourceKey: this.resourceKey,
          targetGitDir: this.gitDirectory,
          wants: pending.commands.map((command) => command.objectId),
        });
        this.write(output, "\n");
        return undefined;
      }

      const results = await this.application.push({
        remoteId: this.remoteId,
        resourceKey: this.resourceKey,
        localGitDir: this.gitDirectory,
        updates: pending.commands.map((command) => command.update),
      });
      this.write(output, serializePushResults(results));
    } catch (error) {
      this.writeFatal(error);
      this.write(output, "\n");
      throw error;
    }
    return undefined;
  }

  private write(output: Pick<NodeJS.WritableStream, "write">, value: string): void {
    output.write(value);
  }

  private writeFatal(error: unknown): void {
    if (typeof error === "object" && error !== null) {
      reportedFatalErrors.add(error);
    }
    const diagnostic = toProtocolFatalDiagnostic(error);
    this.stderr.write(`git-remote-gdrive [${diagnostic.code}]: ${diagnostic.message}\n`);
  }
}
