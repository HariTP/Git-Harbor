import { describe, expect, test, vi } from "vitest";

import {
  AuthenticationRecovery,
  type AuthenticationPrompt,
  type ProviderAuthenticator,
} from "../../src/auth/authentication-recovery.js";
import { GitStorageError } from "../../src/domain/errors.js";

function authenticator(reauthenticate = vi.fn(async () => undefined)): ProviderAuthenticator {
  return { providerName: "Example Drive", reauthenticate };
}

function prompt(answer: boolean): AuthenticationPrompt {
  return { confirm: vi.fn(async () => answer) };
}

describe("AuthenticationRecovery", () => {
  test("prompts, reauthenticates, resets provider state, and retries once", async () => {
    const reauthenticate = vi.fn(async () => undefined);
    const confirmation = prompt(true);
    const reset = vi.fn();
    const operation = vi.fn()
      .mockRejectedValueOnce(new GitStorageError("AUTH_REFRESH_FAILED", "expired"))
      .mockResolvedValueOnce("completed");
    const recovery = new AuthenticationRecovery({
      authenticator: authenticator(reauthenticate),
      prompt: confirmation,
    });

    await expect(recovery.run(operation, reset)).resolves.toBe("completed");
    expect(confirmation.confirm).toHaveBeenCalledWith("Example Drive");
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("does not retry when the user declines", async () => {
    const reauthenticate = vi.fn(async () => undefined);
    const operation = vi.fn(async () => {
      throw new GitStorageError("AUTH_REQUIRED", "expired");
    });
    const recovery = new AuthenticationRecovery({
      authenticator: authenticator(reauthenticate),
      prompt: prompt(false),
    });

    await expect(recovery.run(operation)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledOnce();
  });

  test("does not prompt for non-authentication failures", async () => {
    const confirmation = prompt(true);
    const recovery = new AuthenticationRecovery({ authenticator: authenticator(), prompt: confirmation });
    await expect(recovery.run(async () => {
      throw new GitStorageError("DRIVE_RATE_LIMITED", "later");
    })).rejects.toMatchObject({ code: "DRIVE_RATE_LIMITED" });
    expect(confirmation.confirm).not.toHaveBeenCalled();
  });

  test("turns an unavailable controlling terminal into actionable authentication guidance", async () => {
    const recovery = new AuthenticationRecovery({
      authenticator: authenticator(),
      prompt: { confirm: async () => { throw new Error("no terminal"); } },
    });
    await expect(recovery.run(async () => {
      throw new GitStorageError("AUTH_REQUIRED", "expired");
    })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("git gdrive auth login"),
    });
  });
});
