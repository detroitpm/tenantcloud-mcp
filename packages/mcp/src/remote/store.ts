import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** A teammate allowed to use the hosted server. */
export interface RemoteUser {
  id: number;
  email: string;
  /** sha256 of the invite code; the code itself is shown once at invite time. */
  inviteCodeHash: string;
}

/** A pending OAuth authorization code issued after a successful login. */
export interface AuthCodeRecord {
  userId: number;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

/** An issued OAuth access or refresh token (stored by sha256 hash). */
export interface GrantRecord {
  userId: number;
  clientId: string;
  kind: "access" | "refresh";
  expiresAt: number;
}

/**
 * Persistence for the hosted (multi-user) server: users, the encrypted
 * TenantCloud token vault, and OAuth state. Implementations: PgRemoteStore
 * (production), MemoryRemoteStore (tests/dev).
 */
export interface RemoteStore {
  upsertUser(email: string, inviteCodeHash: string): Promise<RemoteUser>;
  getUserByEmail(email: string): Promise<RemoteUser | null>;
  getUserById(id: number): Promise<RemoteUser | null>;

  saveVault(userId: number, sealed: string): Promise<void>;
  loadVault(userId: number): Promise<string | null>;
  deleteVault(userId: number): Promise<void>;
  listVaultUserIds(): Promise<number[]>;

  saveClient(client: OAuthClientInformationFull): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | null>;

  saveAuthCode(code: string, record: AuthCodeRecord): Promise<void>;
  /** Returns and atomically removes the record (single-use codes). */
  takeAuthCode(code: string): Promise<AuthCodeRecord | null>;

  saveGrant(tokenHash: string, record: GrantRecord): Promise<void>;
  getGrant(tokenHash: string): Promise<GrantRecord | null>;
  deleteGrant(tokenHash: string): Promise<void>;
  /** Removes every access and refresh token issued to a user (offboarding). */
  deleteGrantsForUser(userId: number): Promise<void>;
}

export class MemoryRemoteStore implements RemoteStore {
  private nextUserId = 1;
  private readonly users = new Map<number, RemoteUser>();
  private readonly vaults = new Map<number, string>();
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly authCodes = new Map<string, AuthCodeRecord>();
  private readonly grants = new Map<string, GrantRecord>();

  upsertUser(email: string, inviteCodeHash: string): Promise<RemoteUser> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === normalized) {
        const updated = { ...user, inviteCodeHash };
        this.users.set(user.id, updated);
        return Promise.resolve(updated);
      }
    }
    const user: RemoteUser = { id: this.nextUserId++, email: normalized, inviteCodeHash };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  getUserByEmail(email: string): Promise<RemoteUser | null> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === normalized) {
        return Promise.resolve(user);
      }
    }
    return Promise.resolve(null);
  }

  getUserById(id: number): Promise<RemoteUser | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  saveVault(userId: number, sealed: string): Promise<void> {
    this.vaults.set(userId, sealed);
    return Promise.resolve();
  }

  loadVault(userId: number): Promise<string | null> {
    return Promise.resolve(this.vaults.get(userId) ?? null);
  }

  deleteVault(userId: number): Promise<void> {
    this.vaults.delete(userId);
    return Promise.resolve();
  }

  listVaultUserIds(): Promise<number[]> {
    return Promise.resolve([...this.vaults.keys()]);
  }

  saveClient(client: OAuthClientInformationFull): Promise<void> {
    this.clients.set(client.client_id, client);
    return Promise.resolve();
  }

  getClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    return Promise.resolve(this.clients.get(clientId) ?? null);
  }

  saveAuthCode(code: string, record: AuthCodeRecord): Promise<void> {
    this.authCodes.set(code, record);
    return Promise.resolve();
  }

  takeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const record = this.authCodes.get(code) ?? null;
    this.authCodes.delete(code);
    return Promise.resolve(record);
  }

  saveGrant(tokenHash: string, record: GrantRecord): Promise<void> {
    this.grants.set(tokenHash, record);
    return Promise.resolve();
  }

  getGrant(tokenHash: string): Promise<GrantRecord | null> {
    return Promise.resolve(this.grants.get(tokenHash) ?? null);
  }

  deleteGrant(tokenHash: string): Promise<void> {
    this.grants.delete(tokenHash);
    return Promise.resolve();
  }

  deleteGrantsForUser(userId: number): Promise<void> {
    for (const [hash, grant] of this.grants) {
      if (grant.userId === userId) {
        this.grants.delete(hash);
      }
    }
    return Promise.resolve();
  }
}
