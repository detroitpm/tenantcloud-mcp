import { parseVaultKey } from "./crypto.js";
import { createRemoteApp } from "./httpServer.js";
import { MemoryRemoteStore, type RemoteStore } from "./store.js";
import { PgRemoteStore } from "./pgStore.js";
import { VaultTokenProvider } from "./vaultTokenProvider.js";
import { setSignInHint } from "../tools/helpers.js";

const KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * `tc-mcp serve` - run the hosted multi-user server (Railway etc.).
 *
 * Environment:
 *   PORT          - listen port (Railway injects this). Default 3000.
 *   BASE_URL      - public https URL of the deployment (required: OAuth issuer)
 *   TC_VAULT_KEY  - 64 hex chars; encrypts the token vault (required)
 *   TC_ADMIN_KEY  - bearer key for /admin/* endpoints (required)
 *   DATABASE_URL  - Postgres connection string. Omitted -> in-memory store
 *                   (every restart loses pairings; only for trying it out).
 */
export async function serve(): Promise<number> {
  const baseUrl = process.env["BASE_URL"];
  const vaultKeyHex = process.env["TC_VAULT_KEY"];
  const adminKey = process.env["TC_ADMIN_KEY"];
  const port = Number(process.env["PORT"] ?? 3000);

  if (!baseUrl || !vaultKeyHex || !adminKey) {
    console.error("Error: BASE_URL, TC_VAULT_KEY and TC_ADMIN_KEY must be set.");
    console.error("Generate a vault key with: openssl rand -hex 32");
    return 1;
  }

  const vaultKey = parseVaultKey(vaultKeyHex);

  let store: RemoteStore;
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl) {
    store = await PgRemoteStore.connect(databaseUrl);
    console.error("Connected to Postgres.");
  } else {
    store = new MemoryRemoteStore();
    console.error("WARNING: DATABASE_URL not set - using in-memory storage. Pairings are lost on restart.");
  }

  setSignInHint(
    "Their TenantCloud connection is missing or expired. They need to re-pair: " +
      'run "node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js login --remote <server-url> --email <their email> --code <their invite code>" on their computer ' +
      '(from the team copy of the connector; never "npx tc-mcp", which is an unrelated npm package), then retry.',
  );

  const app = createRemoteApp({ store, vaultKey, baseUrl, adminKey });
  app.listen(port, () => {
    console.error(`tc-mcp remote server listening on :${port} (${baseUrl})`);
  });

  // Keep-alive: refresh every paired user's TenantCloud token chain daily so
  // refresh tokens stay warm even when nobody is using the connector.
  const keepalive = async () => {
    try {
      const userIds = await store.listVaultUserIds();
      for (const userId of userIds) {
        const provider = new VaultTokenProvider(userId, store, vaultKey);
        const token = await provider.getToken();
        console.error(`keepalive: user ${userId} ${token ? "ok" : "FAILED (needs re-pair)"}`);
      }
    } catch (error) {
      console.error("keepalive error:", error instanceof Error ? error.message : String(error));
    }
  };
  setInterval(() => {
    void keepalive();
  }, KEEPALIVE_INTERVAL_MS).unref();

  // Stay alive until the process is stopped.
  return new Promise<number>(() => {});
}
