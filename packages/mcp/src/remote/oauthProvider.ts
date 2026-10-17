import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomSecret, sha256hex } from "./crypto.js";
import type { RemoteStore } from "./store.js";

const AUTH_CODE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour; claude.ai refreshes silently
const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;

export const TC_SCOPE = "tenantcloud";

/**
 * Where sign-in codes may be sent. Registration is open (claude.ai registers
 * itself), so without this list anyone could register a client pointing at
 * their own site and phish a teammate's invite code through our real login
 * page. Allowed: Claude's web callbacks and loopback addresses (Claude Code /
 * Claude Desktop run a local callback). EXTRA_REDIRECT_URIS (comma-separated,
 * exact match) adds more.
 */
const CLAUDE_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

export function isAllowedRedirectUri(uri: string): boolean {
  const extra = (process.env["EXTRA_REDIRECT_URIS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) {
    return true;
  }
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Escape a string for safe interpolation into the login page HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loginPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TenantCloud MCP - Sign in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; padding-top: 8vh; background: #f5f5f4; }
  form { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 2rem; width: 22rem; }
  h1 { font-size: 1.1rem; margin-top: 0; }
  label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #444; }
  input[type=email], input[type=text] { width: 100%; padding: 0.5rem; margin-top: 0.25rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
  button { margin-top: 1.5rem; width: 100%; padding: 0.6rem; border: 0; border-radius: 4px; background: #1a56db; color: #fff; font-size: 1rem; cursor: pointer; }
  .error { color: #b91c1c; font-size: 0.9rem; margin-top: 1rem; }
</style></head>
<body>
  <form method="post" action="authorize/login">
      ${hidden}
      <h1>Sign in to the TenantCloud connector</h1>
      <p style="font-size:0.85rem;color:#666">Use the work email and invite code your administrator gave you.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <label>Email<input type="email" name="email" required autofocus></label>
      <label>Invite code<input type="text" name="invite_code" placeholder="XXXX-XXXX" required></label>
      <button type="submit">Continue</button>
  </form>
</body></html>`;
}

/**
 * Self-contained OAuth 2.1 provider for the hosted server: claude.ai (or any
 * MCP client) registers dynamically, the user authenticates on our login page
 * with email + admin-issued invite code, and we issue opaque bearer tokens
 * (stored hashed). AuthInfo.extra.userId links every MCP request to the
 * teammate whose TenantCloud vault entry should be used.
 */
export class VaultOAuthProvider implements OAuthServerProvider {
  constructor(private readonly store: RemoteStore) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      async getClient(clientId: string) {
        return (await store.getClient(clientId)) ?? undefined;
      },
      async registerClient(client) {
        const full = client as OAuthClientInformationFull;
        const rejected = full.redirect_uris.filter((uri) => !isAllowedRedirectUri(String(uri)));
        if (rejected.length > 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${rejected.join(", ")}`);
        }
        await store.saveClient(full);
        return full;
      },
    };
  }

  authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Render the login form, threading the OAuth parameters through as
    // hidden fields; /authorize/login validates the invite and redirects.
    res
      .status(200)
      .type("html")
      .send(
        loginPage({
          client_id: _client.client_id,
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          state: params.state ?? "",
          scopes: (params.scopes ?? []).join(" "),
        }),
      );
    return Promise.resolve();
  }

  /** Called by the /authorize/login POST route after form submission. */
  async completeLogin(input: {
    email: string;
    inviteCode: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
  }): Promise<{ ok: true; redirect: string } | { ok: false; html: string }> {
    const retry = (error: string) => ({
      ok: false as const,
      html: loginPage(
        {
          client_id: input.clientId,
          redirect_uri: input.redirectUri,
          code_challenge: input.codeChallenge,
          state: input.state,
          scopes: TC_SCOPE,
        },
        error,
      ),
    });

    const client = await this.store.getClient(input.clientId);
    if (!client || !client.redirect_uris.includes(input.redirectUri) || !isAllowedRedirectUri(input.redirectUri)) {
      return retry("Invalid client or redirect URI.");
    }

    const user = await this.store.getUserByEmail(input.email);
    if (!user || sha256hex(input.inviteCode.trim().toUpperCase()) !== user.inviteCodeHash) {
      return retry("Email or invite code not recognized.");
    }

    const code = randomSecret("tcc_");
    await this.store.saveAuthCode(code, {
      userId: user.id,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const redirect = new URL(input.redirectUri);
    redirect.searchParams.set("code", code);
    if (input.state) {
      redirect.searchParams.set("state", input.state);
    }
    return { ok: true, redirect: redirect.href };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    // Peek without consuming: the SDK verifies PKCE before exchanging.
    const record = await this.store.takeAuthCode(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    // Re-store so the subsequent exchange can consume it.
    await this.store.saveAuthCode(authorizationCode, record);
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const record = await this.store.takeAuthCode(authorizationCode);
    if (!record || record.expiresAt < Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return this.issueTokens(record.userId, client.client_id);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const hash = sha256hex(refreshToken);
    const grant = await this.store.getGrant(hash);
    if (
      !grant ||
      grant.kind !== "refresh" ||
      grant.clientId !== client.client_id ||
      grant.expiresAt < Date.now()
    ) {
      throw new InvalidGrantError("invalid or expired refresh token");
    }
    // Rotate the refresh token on every use.
    await this.store.deleteGrant(hash);
    return this.issueTokens(grant.userId, client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = await this.store.getGrant(sha256hex(token));
    if (!grant || grant.kind !== "access" || grant.expiresAt < Date.now()) {
      // Must be InvalidTokenError: the SDK's bearer middleware turns it into
      // a 401 + WWW-Authenticate, which is what makes clients re-run OAuth.
      // Anything else becomes a 500 and clients give up instead.
      throw new InvalidTokenError("invalid or expired access token");
    }
    return {
      token,
      clientId: grant.clientId,
      scopes: [TC_SCOPE],
      expiresAt: Math.floor(grant.expiresAt / 1000),
      extra: { userId: grant.userId },
    };
  }

  private async issueTokens(userId: number, clientId: string): Promise<OAuthTokens> {
    const accessToken = randomSecret("tca_");
    const refreshToken = randomSecret("tcr_");
    await this.store.saveGrant(sha256hex(accessToken), {
      userId,
      clientId,
      kind: "access",
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000,
    });
    await this.store.saveGrant(sha256hex(refreshToken), {
      userId,
      clientId,
      kind: "refresh",
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_S * 1000,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: TC_SCOPE,
    };
  }
}
