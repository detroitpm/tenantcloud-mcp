import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TcClient } from "tenantcloud-client";
import { createServer } from "../server.js";
import { randomInviteCode, safeEqual, sha256hex } from "./crypto.js";
import { VaultOAuthProvider, TC_SCOPE } from "./oauthProvider.js";
import type { RemoteStore } from "./store.js";
import { sealTokenSet, VaultTokenProvider } from "./vaultTokenProvider.js";

export interface RemoteAppOptions {
  store: RemoteStore;
  vaultKey: Buffer;
  /** Public base URL of this deployment, e.g. https://tc-mcp.up.railway.app */
  baseUrl: string;
  /** Bearer key required on /admin/* endpoints. */
  adminKey: string;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  userId: number;
}

/**
 * The hosted (multi-user) server: OAuth 2.1 authorization server + protected
 * Streamable HTTP MCP endpoint + pairing and admin endpoints. Every MCP
 * session is bound to the teammate who authenticated, and their tool calls
 * run with their own TenantCloud tokens from the encrypted vault.
 */
export function createRemoteApp(options: RemoteAppOptions): express.Express {
  const { store, vaultKey, adminKey } = options;
  const issuerUrl = new URL(options.baseUrl);
  const provider = new VaultOAuthProvider(store);
  const sessions = new Map<string, McpSession>();

  const app = express();
  // Railway (and most hosts) sit one proxy hop in front; trust it so rate
  // limits key on the real client IP instead of lumping everyone together.
  app.set("trust proxy", 1);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    // The login page must never be framed by another site (clickjacking).
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false }));

  // OAuth endpoints: /.well-known/*, /authorize, /token, /register
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: [TC_SCOPE],
      resourceName: "TenantCloud MCP",
    }),
  );

  // Invite codes are the only secret on these two routes, so cap guessing.
  const credentialLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "too many attempts; try again in 15 minutes" },
  });
  const isAdmin = (req: Request) => safeEqual(req.headers.authorization ?? "", `Bearer ${adminKey}`);

  // Login form submission (the page rendered by provider.authorize()).
  app.post("/authorize/login", credentialLimiter, async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const result = await provider.completeLogin({
      email: body["email"] ?? "",
      inviteCode: body["invite_code"] ?? "",
      clientId: body["client_id"] ?? "",
      redirectUri: body["redirect_uri"] ?? "",
      codeChallenge: body["code_challenge"] ?? "",
      state: body["state"] ?? "",
    });
    if (result.ok) {
      res.redirect(result.redirect);
    } else {
      res.status(200).type("html").send(result.html);
    }
  });

  // Pairing: upload a TenantCloud token set obtained via local browser login.
  app.post("/pair", credentialLimiter, async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const { email, code, accessToken, refreshToken, fingerprint } = body;
    if (!email || !code || !accessToken || !refreshToken || !fingerprint) {
      res.status(400).json({ error: "email, code, accessToken, refreshToken, fingerprint are required" });
      return;
    }
    const user = await store.getUserByEmail(email);
    if (!user || sha256hex(code.trim().toUpperCase()) !== user.inviteCodeHash) {
      res.status(403).json({ error: "email or invite code not recognized" });
      return;
    }
    await store.saveVault(user.id, sealTokenSet({ accessToken, refreshToken, fingerprint }, vaultKey));
    res.status(200).json({ paired: true, email: user.email });
  });

  // Admin: invite (or re-invite) a teammate. Returns the invite code ONCE.
  app.post("/admin/invite", credentialLimiter, async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: "admin key required" });
      return;
    }
    const email = (req.body as { email?: string }).email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    const inviteCode = randomInviteCode();
    const user = await store.upsertUser(email, sha256hex(inviteCode));
    res.status(200).json({ email: user.email, inviteCode });
  });

  // Admin: revoke a teammate's pairing (their TenantCloud tokens).
  app.post("/admin/revoke", credentialLimiter, async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: "admin key required" });
      return;
    }
    const email = (req.body as { email?: string }).email?.trim().toLowerCase();
    const user = email ? await store.getUserByEmail(email) : null;
    if (!user) {
      res.status(404).json({ error: "no such user" });
      return;
    }
    await store.deleteVault(user.id);
    // Sign them out of Claude right away, not when their token expires.
    await store.deleteGrantsForUser(user.id);
    // Rotate the invite code hash so existing code can no longer pair or sign in.
    await store.upsertUser(user.email, sha256hex(randomInviteCode()));
    res.status(200).json({ revoked: true, email: user.email });
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // The protected MCP endpoint.
  const bearer = requireBearerAuth({ verifier: provider });
  app.all("/mcp", bearer, async (req: Request, res: Response) => {
    const userId = (req.auth?.extra as { userId?: number } | undefined)?.userId;
    if (typeof userId !== "number") {
      res.status(401).json({ error: "unrecognized token" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "unknown or expired session; reinitialize" });
        return;
      }
      if (session.userId !== userId) {
        res.status(403).json({ error: "session belongs to a different user" });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      res.status(400).json({ error: "expected an initialize request to start a session" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, userId });
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const tcClient = new TcClient(new VaultTokenProvider(userId, store, vaultKey));
    const server = createServer(tcClient);
    // Cast: the SDK's transport declares `onclose: (() => void) | undefined`,
    // which exactOptionalPropertyTypes rejects against Transport's `onclose?`.
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
