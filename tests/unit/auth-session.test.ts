import { readFile, stat } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthSessionImpl } from "../../src/auth/auth-session.js";
import { withIsolatedEnvironment } from "../support/isolated-environment.js";

const desktopCredentials = JSON.stringify({
  installed: {
    client_id: "desktop-client-id",
    client_secret: "desktop-client-secret",
    redirect_uris: ["http://localhost"],
  },
});

const refreshableToken = {
  access_token: "access-token-that-must-never-appear",
  refresh_token: "refresh-token-that-must-never-appear",
  expiry_date: Date.now() + 60_000,
};

afterEach(() => vi.restoreAllMocks());

describe("AuthSession", () => {
  it("creates and returns one stable private installation UUID", async () => {
    await withIsolatedEnvironment(async ({ configDir }) => {
      const installationId = "123e4567-e89b-12d3-a456-426614174000";
      const session = new AuthSessionImpl({
        configRoot: () => configDir,
        createId: () => installationId,
      });

      await expect(session.getInstallationId()).resolves.toBe(installationId);
      await expect(session.getInstallationId()).resolves.toBe(installationId);
      await expect(
        readFile(`${configDir}/installation.json`, "utf8").then((value) => JSON.parse(value)),
      ).resolves.toEqual({ installationId });
      if (process.platform !== "win32") {
        expect((await stat(configDir)).mode & 0o777).toBe(0o700);
        expect((await stat(`${configDir}/installation.json`)).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("rejects malformed installation records without exposing their contents", async () => {
    const malformedValue = "not-a-writer-id-secret";
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      await writeFile(
        "config/installation.json",
        JSON.stringify({ installationId: malformedValue }),
      );
      const session = new AuthSessionImpl({ configRoot: () => configDir });

      await expect(session.getInstallationId()).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Local installation data is invalid.",
      });
      await session.getInstallationId().catch((error: Error) => {
        expect(error.message).not.toContain(malformedValue);
      });
    });
  });

  it("rejects web OAuth credentials without writing them to the private config", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      const credentialsPath = await writeFile(
        "web-client.json",
        JSON.stringify({ web: { client_id: "web-client", client_secret: "web-secret" } }),
      );
      const session = new AuthSessionImpl({ configRoot: () => configDir });

      await expect(session.login(credentialsPath)).rejects.toMatchObject({
        code: "AUTH_CREDENTIALS_INVALID",
        message: "OAuth client credentials are invalid.",
      });
      await expect(readFile(`${configDir}/oauth-client.json`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reports missing credentials as unavailable without exposing configuration details", async () => {
    await withIsolatedEnvironment(async ({ configDir }) => {
      const session = new AuthSessionImpl({ configRoot: () => configDir });

      await expect(session.status()).resolves.toEqual({
        hasCredentials: false,
        hasRefreshToken: false,
        isUsable: false,
      });
      await expect(session.getAuthorizedClient()).rejects.toMatchObject({
        code: "AUTH_CREDENTIALS_MISSING",
        message: "OAuth client credentials were not found.",
      });
    });
  });

  it("stores desktop credentials and a refreshable token in the isolated config directory", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      const credentialsPath = await writeFile("incoming-client.json", desktopCredentials);
      const openBrowser = vi.fn(async () => undefined);
      const session = new AuthSessionImpl({
        configRoot: () => configDir,
        openBrowser,
        startLoopbackAuthorization: async () => ({
          redirectUri: "http://127.0.0.1:43210/oauth2callback",
          waitForCallback: async () => ({ code: "authorization-code" }),
          close: async () => undefined,
        }),
        createOAuthClient: () => ({
          generateAuthUrl: () => "https://accounts.example.test/authorize",
          getToken: async () => ({ tokens: refreshableToken }),
          setCredentials: () => undefined,
          getAccessToken: async () => ({ token: "unused" }),
          credentials: {},
        }) as never,
      });

      await expect(session.login(credentialsPath)).resolves.toEqual({
        hasCredentials: true,
        hasRefreshToken: true,
        isUsable: true,
      });
      await expect(readFile(`${configDir}/oauth-client.json`, "utf8")).resolves.toBe(
        desktopCredentials,
      );
      await expect(
        readFile(`${configDir}/token.json`, "utf8").then((value) => JSON.parse(value)),
      ).resolves.toMatchObject({
        refresh_token: refreshableToken.refresh_token,
      });
      expect(openBrowser).toHaveBeenCalledWith("https://accounts.example.test/authorize");
      if (process.platform !== "win32") {
        await expect(stat(configDir)).resolves.toMatchObject({ mode: expect.any(Number) });
        expect((await stat(configDir)).mode & 0o777).toBe(0o700);
        expect((await stat(`${configDir}/oauth-client.json`)).mode & 0o777).toBe(0o600);
        expect((await stat(`${configDir}/token.json`)).mode & 0o777).toBe(0o600);
        expect((await stat(`${configDir}/installation.json`)).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("refreshes an expired stored token before reporting a usable status", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      await writeFile("config/oauth-client.json", desktopCredentials);
      await writeFile(
        "config/token.json",
        JSON.stringify({ ...refreshableToken, expiry_date: 10 }),
      );
      const oauthClient = {
        credentials: {},
        generateAuthUrl: () => "unused",
        getToken: async () => ({ tokens: refreshableToken }),
        setCredentials: (credentials: typeof refreshableToken) => {
          oauthClient.credentials = credentials;
        },
        getAccessToken: async () => {
          oauthClient.credentials = {
            access_token: "refreshed-access-token-that-must-not-appear",
            expiry_date: 20_000,
            refresh_token: refreshableToken.refresh_token,
          };
          return { token: "refreshed-access-token-that-must-not-appear" };
        },
      };
      const session = new AuthSessionImpl({
        configRoot: () => configDir,
        now: () => 100,
        createOAuthClient: () => oauthClient as never,
      });

      await expect(session.status()).resolves.toEqual({
        hasCredentials: true,
        hasRefreshToken: true,
        isUsable: true,
      });
      await expect(
        readFile(`${configDir}/token.json`, "utf8").then((value) => JSON.parse(value)),
      ).resolves.toMatchObject({
        refresh_token: refreshableToken.refresh_token,
        expiry_date: 20_000,
      });
    });
  });

  it("returns an authorized client only after its stored refresh token succeeds", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      await writeFile("config/oauth-client.json", desktopCredentials);
      await writeFile("config/token.json", JSON.stringify(refreshableToken));
      const oauthClient = {
        credentials: {},
        generateAuthUrl: () => "unused",
        getToken: async () => ({ tokens: refreshableToken }),
        setCredentials: (credentials: typeof refreshableToken) => {
          oauthClient.credentials = credentials;
        },
        getAccessToken: async () => ({ token: "fresh-access-token-not-for-output" }),
      };
      const session = new AuthSessionImpl({
        configRoot: () => configDir,
        createOAuthClient: () => oauthClient as never,
      });

      await expect(session.getAuthorizedClient()).resolves.toBe(oauthClient);
    });
  });

  it("uses GIT_GDRIVE_CONFIG_DIR when no config root is injected", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      await writeFile("config/oauth-client.json", desktopCredentials);
      await writeFile("config/token.json", JSON.stringify(refreshableToken));

      await expect(new AuthSessionImpl().status()).resolves.toEqual({
        hasCredentials: true,
        hasRefreshToken: true,
        isUsable: true,
      });
      expect(process.env.GIT_GDRIVE_CONFIG_DIR).toBe(configDir);
    });
  });

  it("logout removes only the local token and is idempotent", async () => {
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      await writeFile("config/oauth-client.json", desktopCredentials);
      await writeFile("config/token.json", JSON.stringify(refreshableToken));
      await writeFile("config/installation.json", JSON.stringify({ installationId: "local-id" }));
      const session = new AuthSessionImpl({ configRoot: () => configDir });

      await expect(session.logout()).resolves.toBeUndefined();
      await expect(session.logout()).resolves.toBeUndefined();
      await expect(readFile(`${configDir}/oauth-client.json`, "utf8")).resolves.toBe(
        desktopCredentials,
      );
      await expect(readFile(`${configDir}/installation.json`, "utf8")).resolves.toContain(
        "local-id",
      );
      await expect(readFile(`${configDir}/token.json`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps credential and token values out of failures", async () => {
    const secret = "client-secret-not-for-errors";
    await withIsolatedEnvironment(async ({ configDir, writeFile }) => {
      const credentialsPath = await writeFile(
        "bad-client.json",
        JSON.stringify({ installed: { client_id: "client-id", client_secret: secret } }),
      );
      const session = new AuthSessionImpl({ configRoot: () => configDir });

      await expect(session.login(credentialsPath)).rejects.toMatchObject({
        code: "AUTH_CREDENTIALS_INVALID",
      });
      await session.login(credentialsPath).catch((error: Error) => {
        expect(error.message).not.toContain(secret);
      });
    });
  });
});
