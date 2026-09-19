import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";

import { GitStorageError } from "../domain/errors.js";

/** Provider-auth seam used by shared retry and prompting logic. */
export interface ProviderAuthenticator {
  readonly providerName: string;
  reauthenticate(): Promise<void>;
}

export interface AuthenticationPrompt {
  confirm(providerName: string): Promise<boolean>;
}

export interface AuthenticationRecoveryOptions {
  readonly authenticator: ProviderAuthenticator;
  readonly prompt?: AuthenticationPrompt;
}

/** Prompts once, reauthenticates through the provider adapter, then retries once. */
export class AuthenticationRecovery {
  private readonly authenticator: ProviderAuthenticator;
  private readonly prompt: AuthenticationPrompt;

  constructor(options: AuthenticationRecoveryOptions) {
    this.authenticator = options.authenticator;
    this.prompt = options.prompt ?? new ControllingTerminalPrompt();
  }

  async run<T>(operation: () => Promise<T>, beforeRetry?: () => void): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isAuthenticationFailure(error)) throw error;
    }

    let accepted: boolean;
    try {
      accepted = await this.prompt.confirm(this.authenticator.providerName);
    } catch (error) {
      throw new GitStorageError(
        "AUTH_REQUIRED",
        `Authentication expired. Run \`git gdrive auth login --credentials <file>\` and retry.`,
        { cause: error },
      );
    }
    if (!accepted) {
      throw new GitStorageError("AUTH_REQUIRED", "Authentication was not renewed.");
    }

    await this.authenticator.reauthenticate();
    beforeRetry?.();
    return operation();
  }
}

export function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof GitStorageError &&
    (error.code === "AUTH_REQUIRED" || error.code === "AUTH_REFRESH_FAILED");
}

class ControllingTerminalPrompt implements AuthenticationPrompt {
  async confirm(providerName: string): Promise<boolean> {
    const inputPath = process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty";
    const outputPath = process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty";
    const input = createReadStream(inputPath);
    const output = createWriteStream(outputPath);
    const prompt = createInterface({ input, output });
    try {
      const answer = await prompt.question(
        `${providerName} authentication expired. Sign in again using your browser? [Y/n] `,
      );
      const normalized = answer.trim().toLowerCase();
      return normalized === "" || normalized === "y" || normalized === "yes";
    } finally {
      prompt.close();
      input.destroy();
      output.end();
    }
  }
}
