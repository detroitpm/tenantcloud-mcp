import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TcClient, validEmails, validPhones, type TcAuthTokenProvider } from "tenantcloud-client";
import { EntityCache } from "./entityCache.js";
import { enrich } from "./entityEnricher.js";
import { GUIDE } from "./guide.js";
import { CATALOG } from "./catalog.js";
import { VERSION } from "./version.js";
import { maxResultsParam, toolError, toolSuccess } from "./tools/helpers.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerMaintenanceTools } from "./tools/maintenance.js";
import { registerFinancialsTools } from "./tools/financials.js";
import { registerLeasingTools } from "./tools/leasing.js";
import { registerProductivityTools } from "./tools/productivity.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerCrmTools } from "./tools/crm.js";
import { registerExtraWriteTools } from "./tools/extraWrites.js";
import { registerPortfolioTools } from "./tools/portfolio.js";
import { registerGenericTools } from "./tools/generic.js";

export interface ServerOptions {
  /**
   * When provided, the tc_login tool is registered. The callback runs the
   * interactive browser sign-in and resolves true once tokens were obtained.
   */
  interactiveLogin?: (() => Promise<boolean>) | undefined;
}

export function createServer(client: TcClient, options: ServerOptions = {}): McpServer {
  const cache = new EntityCache(client);

  const server = new McpServer({ name: "tc-mcp", version: VERSION });

  if (options.interactiveLogin) {
    const interactiveLogin = options.interactiveLogin;
    server.registerTool(
      "tc_login",
      {
        description:
          "Open a browser window for the user to sign in to TenantCloud. Use when other tools fail with HTTP 401 / not signed in. TELL THE USER a sign-in window is about to open BEFORE calling this; the call waits (up to several minutes) while they complete the sign-in, then reports who is signed in.",
        inputSchema: {},
      },
      async () => {
        try {
          const existing = await client.getUserInfo().catch(() => null);
          if (existing) {
            return toolSuccess({
              alreadySignedIn: true,
              user: { name: `${existing.firstName} ${existing.lastName}`.trim(), email: existing.email },
            });
          }
          const ok = await interactiveLogin();
          if (!ok) {
            return toolError(
              'Sign-in was not completed: the window was closed, timed out, or no Chromium browser was found. The user can also run "tc-mcp login" in a terminal and retry.',
            );
          }
          const user = await client.getUserInfo().catch(() => null);
          return toolSuccess({
            signedIn: true,
            user: user ? { name: `${user.firstName} ${user.lastName}`.trim(), email: user.email } : null,
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  server.registerTool(
    "get_user_info",
    {
      description: "Get information about the currently signed-in TenantCloud user.",
      inputSchema: {},
    },
    async () => {
      try {
        const user = await client.getUserInfo();
        if (!user) {
          return toolError("No user info available. You may not be authenticated.");
        }
        return toolSuccess(user);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_contacts",
    {
      description:
        "List contacts (tenants, professionals) from TenantCloud. Use 'role' to filter by type. Team members/sub-admins are NOT contacts - find them with find_threads or list_threads on the 'admins' channel.",
      inputSchema: {
        role: z
          .enum(["tenant", "professional", "moved_in", "archived"])
          .optional()
          .describe("Filter by role: tenant, professional, moved_in, archived"),
        maxResults: maxResultsParam,
      },
    },
    async ({ role, maxResults }) => {
      try {
        let source = client.contacts;
        switch (role) {
          case "tenant":
            source = source.onlyTenants();
            break;
          case "professional":
            source = source.onlyProfessionals();
            break;
          case "moved_in":
            source = source.onlyMovedIn();
            break;
          case "archived":
            source = source.onlyArchived();
            break;
        }

        const data = await source.getAll(maxResults ?? 100);
        return toolSuccess({ data, count: data.length });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_properties",
    {
      description: "List rental properties from TenantCloud.",
      inputSchema: { maxResults: maxResultsParam },
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults }) => {
      try {
        const data = await client.properties.getAll(maxResults ?? 100);
        return toolSuccess({ data, count: data.length });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_units",
    {
      description: "List rental units from TenantCloud. Can filter by property or occupancy status.",
      inputSchema: {
        propertyId: z.number().int().optional().describe("Filter by property ID"),
        occupancy: z
          .enum(["occupied", "vacant"])
          .optional()
          .describe("Filter by occupancy: occupied, vacant"),
        maxResults: maxResultsParam,
      },
    },
    async ({ propertyId, occupancy, maxResults }) => {
      try {
        let source = client.units;
        if (propertyId !== undefined) {
          source = source.forProperty(propertyId);
        }
        if (occupancy === "occupied") {
          source = source.onlyOccupied();
        } else if (occupancy === "vacant") {
          source = source.onlyVacant();
        }

        const data = await source.getAll(maxResults ?? 100);
        const result = await enrich(
          { data: data as unknown as Array<Record<string, unknown>>, count: data.length },
          cache,
        );
        return toolSuccess(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_transactions",
    {
      description:
        "List financial transactions from TenantCloud. Can filter by tenant, property, unit, status, or category.",
      inputSchema: {
        tenantId: z.number().int().optional().describe("Filter by tenant/contact ID"),
        propertyId: z.number().int().optional().describe("Filter by property ID"),
        unitId: z.number().int().optional().describe("Filter by unit ID"),
        status: z
          .enum(["due", "paid", "partial", "pending", "void", "with_balance", "overdue", "waive"])
          .optional()
          .describe(
            "Filter by status: due, paid, partial, pending, void, with_balance, overdue, waive",
          ),
        category: z
          .enum(["income", "expense", "refund", "credits", "liability"])
          .optional()
          .describe("Filter by category: income, expense, refund, credits, liability"),
        maxResults: maxResultsParam,
      },
    },
    async ({ tenantId, propertyId, unitId, status, category, maxResults }) => {
      try {
        let source = client.transactions;
        if (tenantId !== undefined) {
          source = source.forTenant(tenantId);
        }
        if (propertyId !== undefined) {
          source = source.forProperty(propertyId);
        }
        if (unitId !== undefined) {
          source = source.forUnit(unitId);
        }
        if (status !== undefined) {
          source = source.forStatus(status);
        }
        if (category !== undefined) {
          source = source.forCategory(category);
        }

        const data = await source.getAll(maxResults ?? 100);
        const result = await enrich(
          { data: data as unknown as Array<Record<string, unknown>>, count: data.length },
          cache,
        );
        return toolSuccess(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_leases",
    {
      description:
        "List leases from TenantCloud. Filter by property, unit, or status. status: 'active' " +
        "(current leases only - the default-feeling view, but it EXCLUDES renewals), 'future' " +
        "(renewals and not-yet-started leases, lease_status 1), or 'all' (every status). To trace a " +
        "renewal, list by unitId with status 'all' (or 'future'): a renewal carries previousLeaseId " +
        "pointing at the lease it replaces. To find one tenant's lease, scope by unitId and match on " +
        "tenantId - filtering /leases by tenant directly is unreliable.",
      inputSchema: {
        propertyId: z.number().int().optional().describe("Filter by property ID"),
        unitId: z.number().int().optional().describe("Filter by unit ID"),
        status: z
          .enum(["active", "future", "all"])
          .optional()
          .describe("Filter by status: active (current), future (renewals/upcoming), or all"),
        maxResults: maxResultsParam,
      },
    },
    async ({ propertyId, unitId, status, maxResults }) => {
      try {
        let source = client.leases;
        if (propertyId !== undefined) {
          source = source.forProperty(propertyId);
        }
        if (unitId !== undefined) {
          source = source.forUnit(unitId);
        }
        if (status === "active") {
          source = source.onlyActive();
        } else if (status === "future") {
          source = source.onlyFuture();
        }
        // status === "all" (or undefined) applies no lease_status filter.

        const data = await source.getAll(maxResults ?? 100);
        const result = await enrich(
          { data: data as unknown as Array<Record<string, unknown>>, count: data.length },
          cache,
        );
        return toolSuccess(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // Messaging, maintenance, financials, leasing, and the generic escape hatch.
  registerMessagingTools(server, client);
  registerMaintenanceTools(server, client, cache);
  registerFinancialsTools(server, client, cache);
  registerLeasingTools(server, client, cache);
  registerProductivityTools(server, client);
  registerDocumentTools(server, client);
  registerCrmTools(server, client);
  registerExtraWriteTools(server, client);
  registerPortfolioTools(server, client, cache);
  registerGenericTools(server, client);

  server.registerResource(
    "guide",
    "tc://guide",
    {
      title: "TenantCloud Tool Usage Guide",
      description:
        "Guide for using TenantCloud tools: entities, fields, filters, and how to resolve names to IDs.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }],
    }),
  );

  server.registerResource(
    "catalog",
    "tc://catalog",
    {
      title: "TenantCloud API endpoint catalog",
      description:
        "List of API endpoint paths and JSON:API resource types, for use with the tc_request escape-hatch tool.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: CATALOG }],
    }),
  );

  server.registerResource(
    "property",
    new ResourceTemplate("tc://property/{id}", { list: undefined }),
    {
      title: "Property details by ID",
      description: "Look up a property by its numeric ID. Returns name, address, and status.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const property = await cache.getProperty(Number(id));
      const body = property
        ? {
            id: property.id,
            name: property.name,
            address: `${property.address1} ${property.cityAddress}`,
            status: property.status,
          }
        : `property ${String(id)} not found`;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: typeof body === "string" ? body : JSON.stringify(body),
          },
        ],
      };
    },
  );

  server.registerResource(
    "unit",
    new ResourceTemplate("tc://unit/{id}", { list: undefined }),
    {
      title: "Unit details by ID",
      description:
        "Look up a rental unit by its numeric ID. Returns name, property, price, and occupancy.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const unit = await cache.getUnit(Number(id));
      let text: string;
      if (!unit) {
        text = `unit ${String(id)} not found`;
      } else {
        const propertyName = await cache.getPropertyName(unit.propertyId);
        text = JSON.stringify({
          id: unit.id,
          name: unit.name,
          propertyId: unit.propertyId,
          propertyName,
          price: unit.price,
          isRented: unit.isRented,
        });
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );

  server.registerResource(
    "contact",
    new ResourceTemplate("tc://contact/{id}", { list: undefined }),
    {
      title: "Contact details by ID",
      description: "Look up a contact by its numeric ID. Returns name, emails, and phones.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const contact = await cache.getContact(Number(id));
      const text = contact
        ? JSON.stringify({
            id: contact.id,
            name: contact.name,
            firstName: contact.firstName,
            lastName: contact.lastName,
            emails: validEmails(contact),
            phones: validPhones(contact),
          })
        : `contact ${String(id)} not found`;
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );

  return server;
}

export async function runServer(tokenProvider: TcAuthTokenProvider): Promise<void> {
  // Providers that support an on-demand browser sign-in (CdpTokenProvider)
  // get the tc_login tool; detected structurally to avoid a hard dependency
  // on the cdp subpath.
  const loginCapable = tokenProvider as TcAuthTokenProvider & {
    interactiveLogin?: (signal?: AbortSignal) => Promise<unknown>;
  };
  const interactiveLogin =
    typeof loginCapable.interactiveLogin === "function"
      ? async () => (await loginCapable.interactiveLogin!()) != null
      : undefined;
  const server = createServer(new TcClient(tokenProvider), { interactiveLogin });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
