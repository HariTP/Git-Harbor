# Provider authentication design

Git Storage keeps authentication recovery separate from each storage provider's OAuth implementation.

`ProviderAuthenticator` is the common seam:

```ts
interface ProviderAuthenticator {
  readonly providerName: string;
  reauthenticate(): Promise<void>;
}
```

`AuthenticationRecovery` owns the shared workflow:

1. Run a repository-store operation.
2. If it fails with `AUTH_REQUIRED` or `AUTH_REFRESH_FAILED`, prompt on the controlling terminal.
3. If accepted, call the active provider's `reauthenticate()` implementation.
4. Clear the cached provider client.
5. Retry the original operation once.

The Google Drive auth adapter reuses the Desktop OAuth client already stored in the private config directory and performs its browser/localhost callback flow. A future OneDrive adapter can satisfy the same seam with Microsoft authentication without changing repository or Git logic.

Prompts never use stdin or stdout because those streams carry Git's remote-helper protocol. If no controlling terminal can be opened, recovery fails with an actionable `git gdrive auth login --credentials <file>` message instead of hanging.

Git Storage uses bring-your-own provider credentials. Tokens stay on the user's machine and are not sent to a Git Storage backend.
