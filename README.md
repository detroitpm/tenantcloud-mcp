> ## ⚠️ Detroit Section 8 team: read [TEAM-SETUP.md](TEAM-SETUP.md) instead
> This is our private, reviewed copy. **Do not run `npx tc-mcp`** (anywhere below or online). That npm name belongs to an unrelated project, not this code. Install only by building from this repo with `setup.sh`, as TEAM-SETUP.md explains.

# tenantcloud-client-ts

TypeScript client library and MCP server for [TenantCloud](https://tenantcloud.com), a rental property management platform. A port of [yllibed/TenantCloudClient](https://github.com/yllibed/TenantCloudClient) (C#/.NET), extended well beyond parity.

> **This is not an official TenantCloud product.** TenantCloud does not provide a public API; this library works against their internal endpoints and can break whenever TenantCloud changes their frontend. Use at your own risk.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`packages/client`](packages/client) | `tenantcloud-client` | API client: typed sub-clients for messaging, maintenance, financials, and leasing; paginated sources with fluent filters; generic JSON:API CRUD; token stores (OS credential store, file); CDP-based browser auth |
| [`packages/mcp`](packages/mcp) | `tc-mcp` | MCP server (stdio) exposing TenantCloud to AI agents (Claude Desktop, Claude Code, Cursor), with a `login`/`logout`/`install` CLI |

## Quick start

### Client library

```bash
npm install tenantcloud-client
```

```ts
import { TcClient, SecureTokenStore } from "tenantcloud-client";
import { CdpTokenProvider } from "tenantcloud-client/cdp";

const provider = new CdpTokenProvider({
  tokenStore: new SecureTokenStore(),
  allowInteractiveLogin: true,
});
const tc = new TcClient(provider);

// Reads with fluent filters
const user = await tc.getUserInfo();
const tenants = await tc.contacts.onlyTenants().getAll();
const overdue = await tc.transactions.forCategory("income").forStatus("with_balance").getAll();

// Typed sub-clients
const threads = await tc.messaging.threads("tenant");
await tc.messaging.sendMessage(threads.items[0].id, "Hi!");
const request = await tc.maintenance.create({ title: "Leaky faucet", property_id: 123 });

// First contact with a lead (creates their message thread)
const thread = await tc.leasing.openLeadThread(leadId);
await tc.messaging.sendMessage(thread.id, "Thanks for your interest!");

// Any other endpoint via generic JSON:API CRUD
const tasks = tc.resource("/tasks", "task");
await tasks.create({ title: "Call plumber" });
```

### MCP server

Build from this repo. **Never `npx tc-mcp`**: that npm name is an unrelated project. Needs Node.js 20+ (LTS from nodejs.org). **Windows:** Download ZIP, extract, double-click `setup-windows.cmd` (no Git needed). **Mac:**

```bash
git clone https://github.com/detroitpm/tenantcloud-mcp.git ~/tools/tenantcloud-mcp
bash ~/tools/tenantcloud-mcp/setup.sh
```

`setup.sh` builds the tool, registers it with Claude Code (`claude mcp add --scope user --transport stdio tc-mcp -- node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js mcp`; the trailing `mcp` is required), and opens the TenantCloud sign-in window. Each person signs in with their **own** TenantCloud login. Then fully quit and reopen Claude Code. Sign in again later with `node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js login`. Full steps: [TEAM-SETUP.md](TEAM-SETUP.md).

### Hosted server (Claude on web, teams)

For teammates on claude.ai, `tc-mcp serve` runs a multi-user remote server: OAuth 2.1 in front (claude.ai custom connector flow, email + invite code), an encrypted per-user TenantCloud token vault in Postgres, and per-person pairing via `node packages/mcp/dist/cli.js login --remote`. Each teammate's tool calls run under their own TenantCloud account and permissions.

Each company hosts its own instance (fork or clone this repo - there is no shared multi-company server by design). Step-by-step Railway guide, including CLI commands and troubleshooting: [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md).

## MCP tools

68 tools across seven areas, plus resources `tc://guide`, `tc://catalog`, `tc://property/{id}`, `tc://unit/{id}`, `tc://contact/{id}`:

- **Core reads**: `get_user_info`, `list_contacts`, `list_properties`, `list_units`, `list_transactions`, `list_leases`
- **Messaging**: `list_message_channels`, `list_threads`, `find_threads`, `list_messages`, `send_message`, `message_lead` (first contact with a lead: creates their thread and sends in one step), `mark_thread_read`
- **Maintenance**: `list_maintenance_requests`, `get_maintenance_request`, `create_maintenance_request`, `update_maintenance_request`, `resolve_maintenance_request`, `list_inspections`
- **Financials**: `get_transaction_statistics`, `create_transaction`, `update_transaction`, `delete_transaction`, `list_recurring_transactions`, `list_payments`, `list_reconciliation_accounts`, `owner_balances`
- **Leasing**: `get_lease`, `update_lease`, `list_lease_notices`, `list_applications`, `list_screenings`, `list_leads`, `create_lead`
- **Portfolio**: `list_property_keys`, `create_property_key`, `update_property_key`, `delete_property_key` (Keys & Locks - door/lockbox codes); `list_equipment`, `create_equipment`, `update_equipment`, `delete_equipment`
- **Escape hatch**: `tc_request` (any of the ~1100 cataloged endpoints; see `tc://catalog`)

Tool responses resolve foreign-key IDs to human-readable names via an entity cache, and messenger payloads are slimmed so they fit agent context windows.

## How authentication works

TenantCloud has no OAuth or API keys. The CDP token provider:

1. Returns the in-memory token if its JWT is still valid
2. Loads from the token store, refreshing via `POST /auth/token` if expired
3. Connects to a running Chromium browser (debug port 9222) and extracts `access_token`/`fingerprint` from localStorage and the `tc_refresh_token` cookie of an `app.tenantcloud.com` tab
4. If allowed, launches a temporary browser window for interactive login and polls until you finish signing in

## Development

```bash
npm install
npm run build      # tsc --build for both packages
npm test           # vitest (unit + MCP in-memory transport tests)
TC_AUTH_TOKEN=<jwt> npm test   # also runs live API integration tests
```

See [SPEC.md](SPEC.md) for design decisions and the documented internal API surface (~1100 endpoints, discovered from the SPA bundle; full list in [docs/api-catalog.txt](docs/api-catalog.txt)).

## License

[MIT](LICENSE). Portions derived from [yllibed/TenantCloudClient](https://github.com/yllibed/TenantCloudClient), copyright Carl de Billy, MIT.
