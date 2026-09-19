import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";

import { OAuth2Client, type Credentials } from "google-auth-library";
import open from "open";

import { GitStorageError } from "../domain/errors.js";
import type { ProviderAuthenticator } from "./authentication-recovery.js";
import { resolveConfigPaths, type ConfigPaths } from "./config-paths.js";

const driveFileScope = "https://www.googleapis.com/auth/drive.file";
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AuthStatus {
  readonly hasCredentials: boolean;
  readonly hasRefreshToken: boolean;
  readonly isUsable: boolean;
}

export interface AuthSession extends ProviderAuthenticator {
  login(credentialsPath: string): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<void>;
  getAuthorizedClient(): Promise<OAuth2Client>;
  getInstallationId(): Promise<string>;
}

interface DesktopCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: readonly string[];
}

interface LoopbackAuthorization {
  readonly redirectUri: string;
  waitForCallback(expectedState: string): Promise<{ readonly code: string }>;
  close(): Promise<void>;
}

interface OAuthClientLike {
  credentials: Credentials;
  generateAuthUrl(options: {
    access_type: "offline";
    prompt: "consent";
    scope: readonly string[];
    state: string;
  }): string;
  getToken(code: string): Promise<{ tokens: Credentials }>;
  setCredentials(credentials: Credentials): void;
  getAccessToken(): Promise<{ token?: string | null }>;
}

export interface AuthSessionDependencies {
  readonly configRoot?: () => string;
  readonly createOAuthClient?: (options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) => OAuth2Client;
  readonly openBrowser?: (url: string) => Promise<unknown>;
  readonly startLoopbackAuthorization?: () => Promise<LoopbackAuthorization>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export class AuthSessionImpl implements AuthSession {
  readonly providerName = "Google Drive";
  private readonly dependencies: Required<AuthSessionDependencies>;

  constructor(dependencies: AuthSessionDependencies = {}) {
    this.dependencies = {
      configRoot: dependencies.configRoot ?? (() => resolveConfigPaths().root),
      createOAuthClient:
        dependencies.createOAuthClient ??
        ((options) =>
          new OAuth2Client({
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            redirectUri: options.redirectUri,
          })),
      openBrowser: dependencies.openBrowser ?? ((url) => open(url)),
      startLoopbackAuthorization:
        dependencies.startLoopbackAuthorization ?? startLoopbackAuthorization,
      now: dependencies.now ?? (() => Date.now()),
      createId: dependencies.createId ?? randomUUID,
    };
  }

  async login(credentialsPath: string): Promise<AuthStatus> {
    const credentialsDocument = await this.readExternalCredentials(credentialsPath);
    const credentials = parseDesktopCredentials(credentialsDocument);
    const paths = this.paths();
    await ensurePrivateDirectory(paths.root);
    await writePrivateJson(paths.oauthClient, credentialsDocument);
    await this.ensureInstallation();

    let previousToken: Credentials | null = null;
    try {
      previousToken = await this.readTokenIfPresent(paths);
    } catch (error) {
      if (!(error instanceof GitStorageError) || error.code !== "AUTH_REQUIRED") {
        throw error;
      }
    }
    const loopback = await this.dependencies.startLoopbackAuthorization();
    const state = this.dependencies.createId();
    const client = this.createClient(credentials, loopback.redirectUri);

    try {
      const authorizationUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [driveFileScope],
        state,
      });
      await this.dependencies.openBrowser(authorizationUrl);
      const callback = await loopback.waitForCallback(state);
      const response = await client.getToken(callback.code);
      const token = retainRefreshToken(normalizeToken(response.tokens), previousToken);

      if (!token.refresh_token) {
        throw new GitStorageError(
          "AUTH_REFRESH_FAILED",
          "Authorization did not provide a refreshable token.",
        );
      }
      await writePrivateJson(paths.token, token);
      return availableStatus();
    } catch (error) {
      throw toAuthError(error, "AUTH_REFRESH_FAILED", "Authentication could not be completed.");
    } finally {
      await loopback.close();
    }
  }

  async reauthenticate(): Promise<void> {
    await this.login(this.paths().oauthClient);
  }

  async status(): Promise<AuthStatus> {
    const paths = this.paths();
    const credentials = await this.readStoredCredentialsIfPresent(paths);
    if (!credentials) {
      return unavailableStatus();
    }
    const token = await this.readTokenIfPresent(paths);
    if (!token?.refresh_token) {
      return { hasCredentials: true, hasRefreshToken: false, isUsable: false };
    }

    if (!isExpired(token, this.dependencies.now())) {
      return availableStatus();
    }

    const client = this.createClient(credentials, credentials.redirectUris[0]);
    client.setCredentials(token);
    try {
      const access = await client.getAccessToken();
      if (!access.token) {
        throw new Error("No access token returned");
      }
      await writePrivateJson(paths.token, retainRefreshToken(normalizeToken(client.credentials), token));
      return availableStatus();
    } catch (error) {
      throw toAuthError(error, "AUTH_REFRESH_FAILED", "Stored authentication could not be refreshed.");
    }
  }

  async logout(): Promise<void> {
    const paths = this.paths();
    try {
      await unlink(paths.token);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw toAuthError(error, "INTERNAL_ERROR", "Local authentication could not be cleared.");
      }
    }
  }

  async getAuthorizedClient(): Promise<OAuth2Client> {
    const paths = this.paths();
    const credentials = await this.readStoredCredentials(paths);
    const token = await this.readTokenIfPresent(paths);
    if (!token?.refresh_token) {
      throw new GitStorageError("AUTH_REQUIRED", "Sign in is required before accessing Google Drive.");
    }

    const client = this.createClient(credentials, credentials.redirectUris[0]);
    client.setCredentials(token);
    try {
      const access = await client.getAccessToken();
      if (!access.token) {
        throw new Error("No access token returned");
      }
      await writePrivateJson(paths.token, retainRefreshToken(normalizeToken(client.credentials), token));
      return client as OAuth2Client;
    } catch (error) {
      throw toAuthError(error, "AUTH_REFRESH_FAILED", "Stored authentication could not be refreshed.");
    }
  }

  async getInstallationId(): Promise<string> {
    const paths = this.paths();
    await ensurePrivateDirectory(paths.root);
    try {
      return parseInstallationId(JSON.parse(await readFile(paths.installation, "utf8")));
    } catch (error) {
      if (!isMissingFile(error)) {
        if (error instanceof GitStorageError) {
          throw error;
        }
        throw new GitStorageError("INTERNAL_ERROR", "Local installation data is invalid.");
      }
    }

    const installationId = this.dependencies.createId();
    if (!uuidPattern.test(installationId)) {
      throw new GitStorageError("INTERNAL_ERROR", "Local installation data is invalid.");
    }
    await writePrivateJson(paths.installation, { installationId });
    return installationId;
  }

  private paths(): ConfigPaths {
    return resolveConfigPaths({ configRoot: this.dependencies.configRoot() });
  }

  private createClient(credentials: DesktopCredentials, redirectUri: string): OAuthClientLike {
    return this.dependencies.createOAuthClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri,
    }) as OAuthClientLike;
  }

  private async ensureInstallation(): Promise<void> {
    await this.getInstallationId();
  }

  private async readExternalCredentials(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isMissingFile(error)) {
        throw new GitStorageError("AUTH_CREDENTIALS_MISSING", "OAuth client credentials were not found.");
      }
      throw new GitStorageError("AUTH_CREDENTIALS_INVALID", "OAuth client credentials are invalid.");
    }
  }

  private async readStoredCredentials(paths: ConfigPaths): Promise<DesktopCredentials> {
    const credentials = await this.readStoredCredentialsIfPresent(paths);
    if (!credentials) {
      throw new GitStorageError("AUTH_CREDENTIALS_MISSING", "OAuth client credentials were not found.");
    }
    return credentials;
  }

  private async readStoredCredentialsIfPresent(paths: ConfigPaths): Promise<DesktopCredentials | null> {
    try {
      return parseDesktopCredentials(JSON.parse(await readFile(paths.oauthClient, "utf8")));
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      if (error instanceof GitStorageError) {
        throw error;
      }
      throw new GitStorageError("AUTH_CREDENTIALS_INVALID", "OAuth client credentials are invalid.");
    }
  }

  private async readTokenIfPresent(paths: ConfigPaths): Promise<Credentials | null> {
    try {
      return normalizeToken(JSON.parse(await readFile(paths.token, "utf8")));
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      if (error instanceof GitStorageError) {
        throw error;
      }
      throw new GitStorageError("AUTH_REQUIRED", "Stored authentication token is invalid.");
    }
  }
}

export function createAuthSession(dependencies?: AuthSessionDependencies): AuthSession {
  return new AuthSessionImpl(dependencies);
}

function parseDesktopCredentials(value: unknown): DesktopCredentials {
  if (
    !isRecord(value) ||
    !isRecord(value.installed) ||
    Object.keys(value).some((key) => key !== "installed")
  ) {
    throw new GitStorageError("AUTH_CREDENTIALS_INVALID", "OAuth client credentials are invalid.");
  }
  const installed = value.installed;
  const redirectUris = installed.redirect_uris;
  if (
    typeof installed.client_id !== "string" ||
    installed.client_id.length === 0 ||
    typeof installed.client_secret !== "string" ||
    installed.client_secret.length === 0 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((uri): uri is string => typeof uri === "string" && isLoopbackUri(uri))
  ) {
    throw new GitStorageError("AUTH_CREDENTIALS_INVALID", "OAuth client credentials are invalid.");
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret, redirectUris };
}

function parseInstallationId(value: unknown): string {
  if (!isRecord(value) || typeof value.installationId !== "string" || !uuidPattern.test(value.installationId)) {
    throw new GitStorageError("INTERNAL_ERROR", "Local installation data is invalid.");
  }
  return value.installationId;
}

function normalizeToken(value: unknown): Credentials {
  if (!isRecord(value) || (value.refresh_token !== undefined && typeof value.refresh_token !== "string")) {
    throw new GitStorageError("AUTH_REQUIRED", "Stored authentication token is invalid.");
  }
  const token: Credentials = {};
  for (const field of ["access_token", "refresh_token", "scope", "token_type", "id_token"] as const) {
    if (typeof value[field] === "string") {
      token[field] = value[field];
    }
  }
  if (typeof value.expiry_date === "number" && Number.isFinite(value.expiry_date)) {
    token.expiry_date = value.expiry_date;
  }
  return token;
}

function retainRefreshToken(token: Credentials, prior: Credentials | null): Credentials {
  if (!token.refresh_token && prior?.refresh_token) {
    return { ...token, refresh_token: prior.refresh_token };
  }
  return token;
}

function isExpired(token: Credentials, now: number): boolean {
  return typeof token.access_token !== "string" ||
    typeof token.expiry_date !== "number" ||
    token.expiry_date <= now;
}

function availableStatus(): AuthStatus {
  return { hasCredentials: true, hasRefreshToken: true, isUsable: true };
}

function unavailableStatus(): AuthStatus {
  return { hasCredentials: false, hasRefreshToken: false, isUsable: false };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await setPrivateMode(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await setPrivateMode(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await setPrivateMode(path, 0o600);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // A failed cleanup must not replace the original write failure.
    }
  }
}

async function setPrivateMode(path: string, mode: number): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, mode);
  }
}

function isLoopbackUri(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.protocol === "http:" && (uri.hostname === "localhost" || uri.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function toAuthError(error: unknown, code: "AUTH_REFRESH_FAILED" | "INTERNAL_ERROR", message: string): GitStorageError {
  if (error instanceof GitStorageError) {
    return error;
  }
  return new GitStorageError(code, message);
}

async function startLoopbackAuthorization(): Promise<LoopbackAuthorization> {
  let server: Server | undefined;
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization received. You can close this window.");
      const state = url.searchParams.get("state");
      if (url.searchParams.get("error") || state === null) {
        reject(new GitStorageError("AUTH_REQUIRED", "Authorization was not completed."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        reject(new GitStorageError("AUTH_REQUIRED", "Authorization was not completed."));
        return;
      }
      resolve({ code, state });
    });
  });
  const activeServer = server;
  if (!activeServer) {
    throw new GitStorageError("INTERNAL_ERROR", "Authorization listener could not start.");
  }
  await new Promise<void>((resolve, reject) => {
    activeServer.once("error", reject);
    activeServer.listen(0, "127.0.0.1", () => {
      activeServer.off("error", reject);
      resolve();
    });
  });
  const address = activeServer.address();
  if (!address || typeof address === "string") {
    await closeServer(activeServer);
    throw new GitStorageError("INTERNAL_ERROR", "Authorization listener could not start.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth2callback`,
    waitForCallback: async (expectedState) => {
      const result = await callback;
      if (result.state !== expectedState) {
        throw new GitStorageError("AUTH_REQUIRED", "Authorization was not completed.");
      }
      return { code: result.code };
    },
    close: async () => {
      await closeServer(activeServer);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
