import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TcClient } from "tenantcloud-client";
import { compact, pageParam, toolError, toolSuccess } from "./helpers.js";

export function registerCrmTools(server: McpServer, client: TcClient): void {
  server.registerTool(
    "create_contact",
    {
      description:
        "Create a contact (tenant, professional, owner, etc.). Use list_contacts to read existing contacts.",
      inputSchema: {
        firstName: z.string().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Primary email"),
        phone: z.string().optional().describe("Primary phone"),
        company: z.string().optional().describe("Company name"),
        isCompany: z.boolean().optional().describe("Whether this contact is a company"),
        role: z.string().optional().describe("Role: tenant, professional, owner, etc."),
      },
    },
    async ({ firstName, lastName, email, phone, company, isCompany, role }) => {
      try {
        const contact = await client.crm.create(
          compact({ firstName, lastName, email, phone, company, isCompany, role }),
        );
        return toolSuccess({ created: true, contact });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update_contact",
    {
      description:
        "Update an existing contact's fields. Supports tenant and professional contacts (looked up by id to pick the endpoint).",
      inputSchema: {
        id: z.number().int().describe("Contact ID"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
      },
    },
    async ({ id, firstName, lastName, email, phone, company }) => {
      try {
        const contact = await client.crm.update(
          id,
          compact({ firstName, lastName, email, phone, company }),
        );
        return toolSuccess({ updated: true, contact });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "invite_contact",
    {
      description:
        "Invite a contact to the tenant portal (sends them an email invitation). Confirm intent before sending.",
      inputSchema: {
        email: z.string().describe("Email address to invite"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      },
    },
    async ({ email, firstName, lastName }) => {
      try {
        const result = await client.crm.invite(compact({ email, firstName, lastName }));
        return toolSuccess({ invited: true, result });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_contact_insurances",
    {
      description: "List tenant insurance policies on file.",
      inputSchema: { page: pageParam },
    },
    async ({ page }) => {
      try {
        const { items, pagination } = await client.crm.listInsurances({ page });
        return toolSuccess({ data: items, count: items.length, pagination });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_owner_agreements",
    {
      description: "List owner management agreements (between property owners and the manager).",
      inputSchema: { page: pageParam },
    },
    async ({ page }) => {
      try {
        const { items, pagination } = await client.financials.ownerAgreements({ page });
        return toolSuccess({ data: items, count: items.length, pagination });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
