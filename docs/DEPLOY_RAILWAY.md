# Hosting tc-mcp on Railway (for Claude on web)

The hosted server lets teammates use the TenantCloud connector from claude.ai
(web), with each person acting under **their own TenantCloud account**. It is a
multi-user server: OAuth 2.1 in front (claude.ai's custom-connector flow), an
encrypted per-user token vault in Postgres, and the same MCP tools as the
local stdio server.

## 1. Deploy

Every company hosts its own instance with its own vault - there is no
multi-company mode by design. Pick one of two ways to deploy your own:

- **From local, no GitHub link (recommended for self-hosting)** - `railway up`
  uploads your working copy and Railway builds it. Nothing is tied to a repo, so
  repo pushes never trigger deploys and your Railway project never shows up on
  the public GitHub repo. You ship explicitly. See [CLI deploy](#cli-deploy-no-github-link).
- **From a GitHub fork (auto-deploy on push)** - fork this repo into your own
  account first, then connect that fork in Railway. Use a fork, not the public
  upstream, so your deployments stay under your account.

Either way, `railway.json` already sets the build (`npm install && npm run
build`) and start (`node packages/mcp/dist/cli.js serve`) commands. The Postgres
and env-var setup below is the same for both:

1. Create a Railway project - empty (you will `railway up` from local) or
   connected to your fork (auto-deploy on push).
2. Add a **PostgreSQL** service to the project and attach its `DATABASE_URL`
   to the app service (Railway does this automatically when you reference it).
   You will need a paid Railway plan (Hobby) - the free tier's resource quota
   does not fit an always-on service plus Postgres.
3. Generate the app's public domain first (Settings -> Networking -> Generate
   Domain) - `BASE_URL` below needs it. Then set the app service variables:

   | Variable | Value |
   |----------|-------|
   | `BASE_URL` | the public URL Railway gives the service, e.g. `https://tc-mcp-production.up.railway.app` |
   | `TC_VAULT_KEY` | `openssl rand -hex 32` - encrypts the token vault. Losing it means everyone re-pairs. |
   | `TC_ADMIN_KEY` | `openssl rand -hex 32` - bearer key for the /admin endpoints (invites, revocation) |
   | `DATABASE_URL` | reference to the Postgres service |

4. Deploy. `GET /healthz` should return `{"ok":true}`, and the deploy logs
   should say `Connected to Postgres.`

### CLI deploy (no GitHub link)

Provision the project, set the variables, and deploy your local working copy -
no GitHub connection, so nothing deploys on push and your Railway project stays
off the public repo:

```bash
brew install railway && railway login
railway init --name tenantcloud-mcp
railway add --database postgres
railway add --service tc-mcp-server \
  -v "TC_VAULT_KEY=$(openssl rand -hex 32)" \
  -v "TC_ADMIN_KEY=$(openssl rand -hex 32)" \
  -v 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway service link tc-mcp-server && railway domain
railway variables --set "BASE_URL=https://<the printed domain>"
railway up        # builds + deploys the current directory
```

Ship every later change the same way: `railway up` from the repo directory
(`.gitignore` keeps `node_modules`/`dist` out of the upload; Railway rebuilds).
`railway logs` follows the deploy.

**Already connected a GitHub repo and want to switch to CLI-only?** Cut the link
with `railway service source disconnect --service tc-mcp-server`, then deploy
with `railway up`. Existing Postgres, domain, and env vars are unaffected. To
also clear the deployment records Railway posted onto a public repo, delete them
from the repo's **Settings -> Environments** (and remove the Railway GitHub App
from the repo at **github.com/settings/installations**).

### Troubleshooting

- **First deploy fails its healthcheck / crash-loops**: usually the app booted
  before Postgres finished provisioning (the server connects at startup).
  Wait for the Postgres service to show Online, then redeploy the app.
- **Build warnings** `SecretsUsedInArgOrEnv` and `UndefinedVar '$NIXPACKS_PATH'`
  are benign: Railway's Nixpacks builder passes service variables into the
  Docker build (so Docker's linter flags the *_KEY names) and its generated
  Dockerfile references its own variable. Neither blocks the build.
- **Log says "using in-memory storage"**: the `DATABASE_URL` reference is not
  attached to the app service - pairings would vanish on restart. Fix the
  variable reference and redeploy.

## 2. Invite a teammate (admin)

These commands run the team copy of the connector built by `setup.sh` (see
TEAM-SETUP.md). **Never use `npx tc-mcp`**: that npm name is an unrelated package.

```bash
TC_ADMIN_KEY=<your admin key> node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js invite alice@yourco.com --server https://<your-app>.up.railway.app
```

This prints a one-time invite code and ready-to-send instructions. The invite
code is the teammate's credential for both the connector sign-in and pairing;
re-running `invite` for the same email rotates the code.

## 3. Teammate setup (once per person)

1. **Pair TenantCloud** (on their computer; they must be a sub-admin on your
   TenantCloud account):

   ```bash
   node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js login --remote https://<your-app>.up.railway.app --email alice@yourco.com --code XXXX-XXXX
   ```

   This opens the normal TenantCloud browser sign-in (their password, their
   2FA) and uploads the resulting tokens to the server's encrypted vault. The
   server keeps them fresh from then on (daily keep-alive + refresh on use).

2. **Add the connector in claude.ai**: Settings -> Connectors -> Add custom
   connector -> URL `https://<your-app>.up.railway.app/mcp`. Claude opens the
   server's sign-in page: they enter their email + invite code once, and
   claude.ai stores the resulting OAuth tokens.

## 4. Offboarding

```bash
curl -X POST https://<your-app>.up.railway.app/admin/revoke \
  -H "Authorization: Bearer $TC_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"email":"alice@yourco.com"}'
```

This deletes their TenantCloud tokens from the vault, rotates their invite
code, and signs them out of the connector immediately.
Also remove their sub-admin in TenantCloud itself.

## Security model

- **Two layers**: the OAuth gate controls who can reach the MCP endpoint at
  all (email + invite code -> bearer tokens, stored hashed); the vault decides
  whose TenantCloud tokens each session uses. Sessions are bound to the user
  who authenticated - one teammate can never reach another's tokens.
- **Vault encryption**: token sets are AES-256-GCM encrypted with
  `TC_VAULT_KEY`, which lives only in Railway env vars - a leaked database
  dump alone is useless.
- **TenantCloud permissions still apply**: each teammate's tool calls run as
  their own TenantCloud sub-admin, so TenantCloud enforces their role and its
  audit log shows who did what.
- **Sign-in codes only go to Claude**: open client registration only accepts
  Claude's callbacks (claude.ai / claude.com) and loopback addresses, so a
  look-alike client cannot phish an invite code through the real login page.
  Add other exact callback URLs with `EXTRA_REDIRECT_URIS` (comma-separated).
- **Guessing is capped**: login, pairing and admin routes allow 20 attempts per
  IP per 15 minutes. The login page refuses to be framed by other sites.
- **Revoking is immediate**: `/admin/revoke` also deletes the teammate's Claude
  sign-in tokens, so the connector stops working for them at once.
- **Single instance**: run one replica. TenantCloud rotates refresh tokens on
  every refresh; the server serializes per-user token operations in-process,
  which is only safe with a single instance.
