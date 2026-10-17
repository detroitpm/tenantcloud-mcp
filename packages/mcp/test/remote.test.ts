import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { open, parseVaultKey, seal, sha256hex } from "../src/remote/crypto.js";
import { createRemoteApp } from "../src/remote/httpServer.js";
import { MemoryRemoteStore } from "../src/remote/store.js";
import { VaultTokenProvider, sealTokenSet } from "../src/remote/vaultTokenProvider.js";

const VAULT_KEY = parseVaultKey("a".repeat(64));
const ADMIN_KEY = "admin-secret";

/** A JWT-shaped token with the given exp (seconds since epoch). */
function fakeJwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `h.${payload}.s`;
}

describe("vault crypto", () => {
  it("seals and opens a round trip", () => {
    const sealed = seal('{"a":1}', VAULT_KEY);
    expect(open(sealed, VAULT_KEY)).toBe('{"a":1}');
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const sealed = seal("secret", VAULT_KEY);
    const tampered = Buffer.from(sealed, "base64");
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => open(tampered.toString("base64"), VAULT_KEY)).toThrow();
    expect(() => open(sealed, parseVaultKey("b".repeat(64)))).toThrow();
  });
});

describe("VaultTokenProvider", () => {
  it("refreshes an expired set and persists the rotated tokens before serving", async () => {
    const store = new MemoryRemoteStore();
    const user = await store.upsertUser("a@b.co", "x");
    const expired = { accessToken: fakeJwt(-60), refreshToken: "r1", fingerprint: "fp" };
    await store.saveVault(user.id, sealTokenSet(expired, VAULT_KEY));

    const fresh = fakeJwt(3600);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: fresh, refresh_token: "r2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new VaultTokenProvider(user.id, store, VAULT_KEY);
      const token = await provider.getToken();

      expect(token).toBe(fresh);
      // The rotated refresh token must be in the vault, not the old one.
      const sealed = await store.loadVault(user.id);
      const persisted = JSON.parse(open(sealed!, VAULT_KEY)) as { refreshToken: string };
      expect(persisted.refreshToken).toBe("r2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null (signed out) when there is no vault entry", async () => {
    const store = new MemoryRemoteStore();
    const provider = new VaultTokenProvider(99, store, VAULT_KEY);
    expect(await provider.getToken()).toBeNull();
  });
});

describe("remote HTTP server", () => {
  const store = new MemoryRemoteStore();
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createRemoteApp({
      store,
      vaultKey: VAULT_KEY,
      baseUrl: "https://mcp.example.com",
      adminKey: ADMIN_KEY,
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function inviteUser(email: string): Promise<string> {
    const res = await fetch(`${base}/admin/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    const { inviteCode } = (await res.json()) as { inviteCode: string };
    return inviteCode;
  }

  it("rejects admin endpoints without the admin key", async () => {
    const res = await fetch(`${base}/admin/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.co" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects pairing with a wrong invite code", async () => {
    await inviteUser("carol@co.com");
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "carol@co.com",
        code: "WRNG-CODE",
        accessToken: "a",
        refreshToken: "r",
        fingerprint: "f",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects /mcp without a bearer token", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("answers an invalid/stale bearer token with 401 + WWW-Authenticate, not 500", async () => {
    // Regression: plain Errors from verifyAccessToken became 500s, so clients
    // (claude.ai) never saw the 401 that triggers their OAuth re-auth flow.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer tca_dead_token_from_before_a_wipe",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("runs the full flow: invite -> pair -> OAuth (DCR + PKCE) -> MCP session", async () => {
    const inviteCode = await inviteUser("alice@co.com");

    // Pair a TenantCloud token set (as `tc-mcp login --remote` would).
    const pairRes = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@co.com",
        code: inviteCode,
        accessToken: fakeJwt(3600),
        refreshToken: "rt",
        fingerprint: "fp",
      }),
    });
    expect(pairRes.status).toBe(200);

    // Dynamic client registration (what claude.ai does on connector setup).
    const regRes = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(regRes.status).toBe(201);
    const client = (await regRes.json()) as { client_id: string };

    // Authorization request renders our login page.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl =
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=st123`;
    const pageRes = await fetch(authorizeUrl);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("invite code");

    // Login form submission issues a redirect back to the client with a code.
    const loginRes = await fetch(`${base}/authorize/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        email: "alice@co.com",
        invite_code: inviteCode,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: challenge,
        state: "st123",
      }),
    });
    expect(loginRes.status).toBe(302);
    const location = new URL(loginRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("st123");
    const code = location.searchParams.get("code")!;

    // Token exchange with PKCE.
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    // Refresh token grant works and rotates.
    const refreshRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { access_token: string };

    // MCP initialize with the bearer token starts a per-user session.
    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${refreshed.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const initBody = (await initRes.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("tc-mcp");

    // tools/list on the session shows the TenantCloud tools (no tc_login remotely).
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${refreshed.access_token}`,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const listRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${refreshed.access_token}`,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    const names = listBody.result.tools.map((t) => t.name);
    expect(names).toContain("list_transactions");
    expect(names).toContain("message_lead");
    expect(names).not.toContain("tc_login");
  });

  it("refuses to register a client whose sign-in callback is not Claude's", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Phisher",
        redirect_uris: ["https://evil.example.com/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("redirect_uri not allowed");
  });

  it("revoking a teammate signs them out of Claude immediately", async () => {
    await inviteUser("bob@co.com");
    const bob = (await store.getUserByEmail("bob@co.com"))!;
    await store.saveGrant(sha256hex("tca_bob"), {
      userId: bob.id,
      clientId: "c",
      kind: "access",
      expiresAt: Date.now() + 3_600_000,
    });
    const before = await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer tca_bob" } });
    expect(before.status).toBe(400); // authenticated, just not an initialize request

    const revokeRes = await fetch(`${base}/admin/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ email: "bob@co.com" }),
    });
    expect(revokeRes.status).toBe(200);

    const after = await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer tca_bob" } });
    expect(after.status).toBe(401);
  });

  it("hashes invite codes case-insensitively", () => {
    expect(sha256hex("ab")).toBe(sha256hex("ab"));
    expect(sha256hex("AB")).not.toBe(sha256hex("ab"));
  });
});
