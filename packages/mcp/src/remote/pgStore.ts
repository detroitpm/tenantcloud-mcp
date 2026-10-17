import pg from "pg";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthCodeRecord, GrantRecord, RemoteStore, RemoteUser } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_users (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  invite_code_hash TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS token_vault (
  user_id    INTEGER PRIMARY KEY REFERENCES remote_users(id) ON DELETE CASCADE,
  sealed     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data      JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code           TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES remote_users(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  expires_at     BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES remote_users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
`;

/** Postgres-backed RemoteStore (Railway's managed Postgres in production). */
export class PgRemoteStore implements RemoteStore {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(databaseUrl: string): Promise<PgRemoteStore> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query(SCHEMA);
    return new PgRemoteStore(pool);
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async upsertUser(email: string, inviteCodeHash: string): Promise<RemoteUser> {
    const { rows } = await this.pool.query<{ id: number; email: string; invite_code_hash: string }>(
      `INSERT INTO remote_users (email, invite_code_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET invite_code_hash = EXCLUDED.invite_code_hash
       RETURNING id, email, invite_code_hash`,
      [email.trim().toLowerCase(), inviteCodeHash],
    );
    const row = rows[0]!;
    return { id: row.id, email: row.email, inviteCodeHash: row.invite_code_hash };
  }

  async getUserByEmail(email: string): Promise<RemoteUser | null> {
    const { rows } = await this.pool.query<{ id: number; email: string; invite_code_hash: string }>(
      "SELECT id, email, invite_code_hash FROM remote_users WHERE email = $1",
      [email.trim().toLowerCase()],
    );
    const row = rows[0];
    return row ? { id: row.id, email: row.email, inviteCodeHash: row.invite_code_hash } : null;
  }

  async getUserById(id: number): Promise<RemoteUser | null> {
    const { rows } = await this.pool.query<{ id: number; email: string; invite_code_hash: string }>(
      "SELECT id, email, invite_code_hash FROM remote_users WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row ? { id: row.id, email: row.email, inviteCodeHash: row.invite_code_hash } : null;
  }

  async saveVault(userId: number, sealed: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO token_vault (user_id, sealed, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
      [userId, sealed],
    );
  }

  async loadVault(userId: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ sealed: string }>(
      "SELECT sealed FROM token_vault WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.sealed ?? null;
  }

  async deleteVault(userId: number): Promise<void> {
    await this.pool.query("DELETE FROM token_vault WHERE user_id = $1", [userId]);
  }

  async listVaultUserIds(): Promise<number[]> {
    const { rows } = await this.pool.query<{ user_id: number }>("SELECT user_id FROM token_vault");
    return rows.map((r) => r.user_id);
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, data) VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET data = EXCLUDED.data`,
      [client.client_id, JSON.stringify(client)],
    );
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    const { rows } = await this.pool.query<{ data: OAuthClientInformationFull }>(
      "SELECT data FROM oauth_clients WHERE client_id = $1",
      [clientId],
    );
    return rows[0]?.data ?? null;
  }

  async saveAuthCode(code: string, record: AuthCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_auth_codes (code, user_id, client_id, code_challenge, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, record.userId, record.clientId, record.codeChallenge, record.redirectUri, record.expiresAt],
    );
  }

  async takeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const { rows } = await this.pool.query<{
      user_id: number;
      client_id: string;
      code_challenge: string;
      redirect_uri: string;
      expires_at: string;
    }>("DELETE FROM oauth_auth_codes WHERE code = $1 RETURNING *", [code]);
    const row = rows[0];
    return row
      ? {
          userId: row.user_id,
          clientId: row.client_id,
          codeChallenge: row.code_challenge,
          redirectUri: row.redirect_uri,
          expiresAt: Number(row.expires_at),
        }
      : null;
  }

  async saveGrant(tokenHash: string, record: GrantRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_grants (token_hash, user_id, client_id, kind, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tokenHash, record.userId, record.clientId, record.kind, record.expiresAt],
    );
  }

  async getGrant(tokenHash: string): Promise<GrantRecord | null> {
    const { rows } = await this.pool.query<{
      user_id: number;
      client_id: string;
      kind: "access" | "refresh";
      expires_at: string;
    }>("SELECT user_id, client_id, kind, expires_at FROM oauth_grants WHERE token_hash = $1", [tokenHash]);
    const row = rows[0];
    return row
      ? { userId: row.user_id, clientId: row.client_id, kind: row.kind, expiresAt: Number(row.expires_at) }
      : null;
  }

  async deleteGrant(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM oauth_grants WHERE token_hash = $1", [tokenHash]);
  }

  async deleteGrantsForUser(userId: number): Promise<void> {
    await this.pool.query("DELETE FROM oauth_grants WHERE user_id = $1", [userId]);
  }
}
