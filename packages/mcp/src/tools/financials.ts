import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TcClient } from "tenantcloud-client";
import type { EntityCache } from "../entityCache.js";
import { enrich } from "../entityEnricher.js";
import { compact, pageParam, toolError, toolSuccess } from "./helpers.js";

function filterRecord(
  o: Record<string, number | string | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function registerFinancialsTools(server: McpServer, client: TcClient, cache: EntityCache): void {
  server.registerTool(
    "get_transaction_statistics",
    {
      description:
        "Get aggregate income/expense/balance statistics. Filter by property, unit, tenant, status, or category.",
      inputSchema: {
        propertyId: z.number().int().optional().describe("Filter by property ID"),
        unitId: z.number().int().optional().describe("Filter by unit ID"),
        clientId: z.number().int().optional().describe("Filter by tenant/contact ID"),
        status: z.string().optional(),
        category: z.string().optional(),
      },
    },
    async ({ propertyId, unitId, clientId, status, category }) => {
      try {
        const stats = await client.financials.statistics(
          filterRecord({
            property_id: propertyId,
            unit_id: unitId,
            client_id: clientId,
            status,
            category,
          }),
        );
        return toolSuccess({ data: stats });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_transaction",
    {
      description:
        "Create a financial transaction (a charge/invoice or expense). Amount is in dollars. category is income or expense.",
      inputSchema: {
        amount: z.number().describe("Amount (dollars)"),
        category: z.string().describe("income, expense, refund, credits, or liability"),
        date: z.string().describe("Transaction date (YYYY-MM-DD)"),
        name: z.string().optional().describe("Line-item name / detail"),
        details: z.string().optional().describe("Description"),
        propertyId: z.number().int().optional(),
        unitId: z.number().int().optional(),
        clientId: z.number().int().optional().describe("Tenant/contact ID (the payer)"),
        accountId: z.number().int().optional().describe("Account ID to post against"),
      },
    },
    async ({ amount, category, date, name, details, propertyId, unitId, clientId, accountId }) => {
      try {
        const created = await client.financials.createTransaction(
          compact({
            amount,
            category,
            date,
            name,
            details,
            property_id: propertyId,
            unit_id: unitId,
            client_id: clientId,
            account_id: accountId,
          }),
        );
        return toolSuccess({ created: true, transaction: created });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update_transaction",
    {
      description: "Update fields on an existing transaction.",
      inputSchema: {
        id: z.number().int().describe("Transaction ID"),
        amount: z.number().optional(),
        name: z.string().optional(),
        details: z.string().optional(),
        date: z.string().optional().describe("YYYY-MM-DD"),
        status: z.string().optional(),
      },
    },
    async ({ id, amount, name, details, date, status }) => {
      try {
        const updated = await client.financials.updateTransaction(
          id,
          compact({ amount, name, details, date, status }),
        );
        return toolSuccess({ updated: true, transaction: updated });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "delete_transaction",
    {
      description: "Delete a transaction by ID.",
      inputSchema: { id: z.number().int().describe("Transaction ID") },
    },
    async ({ id }) => {
      try {
        await client.financials.deleteTransaction(id);
        return toolSuccess({ deleted: true, id });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_recurring_transactions",
    {
      description: "List recurring transactions (scheduled rent charges, recurring expenses).",
      inputSchema: { page: pageParam },
    },
    async ({ page }) => {
      try {
        const { items, pagination } = await client.financials.listRecurring({ page });
        const result = await enrich({ data: items, count: items.length }, cache);
        return toolSuccess({ ...result, pagination });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_payments",
    {
      description: "List recorded payments. Filter by tenant (client) or property.",
      inputSchema: {
        clientId: z.number().int().optional().describe("Filter by tenant/contact ID"),
        propertyId: z.number().int().optional().describe("Filter by property ID"),
        page: pageParam,
      },
    },
    async ({ clientId, propertyId, page }) => {
      try {
        const { items, pagination } = await client.financials.listPayments(
          filterRecord({ client_id: clientId, property_id: propertyId }),
          { page },
        );
        const result = await enrich({ data: items, count: items.length }, cache);
        return toolSuccess({ ...result, pagination });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_reconciliation_accounts",
    {
      description: "List bank accounts available for reconciliation.",
      inputSchema: {},
    },
    async () => {
      try {
        const { items } = await client.financials.reconciliationBankAccounts();
        return toolSuccess({ data: items, count: items.length });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "owner_balances",
    {
      description: "Get owner balance statistics (amounts owed to/by property owners).",
      inputSchema: {},
    },
    async () => {
      try {
        return toolSuccess(await client.financials.ownerBalances());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // The company's own P&L, as TenantCloud's operating statement reports it: company-level
  // lines (no property) plus the management fees charged to every property.
  server.registerTool(
    "company_pnl",
    {
      description:
        "Read-only. The property manager's own profit and loss for a date range, from TenantCloud's operating " +
        "statement: every company-level line (not tied to a property, e.g. General Expense: Software, Salary) and " +
        "every Management fees line charged to owners' properties. amountDue is billed, amountPaid is paid.",
      inputSchema: {
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First date, YYYY-MM-DD"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last date, YYYY-MM-DD"),
        basis: z.enum(["cash", "accrual"]).optional().describe("Accounting basis (default cash)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ startDate, endDate, basis }) => {
      try {
        type Report = {
          data?: Array<{ attributes?: Record<string, unknown> }>;
          meta?: { cursor?: { next?: string | null } };
        };
        const rows: Record<string, unknown>[] = [];
        let cursor = "";
        // property_id 0 means every property plus company-level lines; the report pages by cursor.
        for (let page = 0; page < 100; page++) {
          const raw = (await client.request("GET", "/reports/transactions/operating_statement", {
            query: {
              cursor,
              "filter[property_id]": 0,
              "filter[op_type]": basis ?? "cash",
              "filter[date][gte]": startDate,
              "filter[date][lte]": endDate,
            },
          })) as Report;
          for (const item of raw.data ?? []) {
            const a = item.attributes ?? {};
            const company = a["property_id"] == null;
            if (!company && a["account_category"] !== "Management fees") continue;
            rows.push(
              compact({
                scope: company ? "company" : "property",
                type: a["category"],
                category: a["account_category"],
                subCategory: a["account_sub_category"] || undefined,
                accountId: a["account_id"],
                propertyId: a["property_id"] ?? undefined,
                amountDue: Number(a["amount_due"] ?? 0),
                amountPaid: Number(a["amount_paid"] ?? 0),
              }),
            );
          }
          const next = raw.meta?.cursor?.next;
          if (!next) break;
          cursor = next;
        }
        return toolSuccess({ rows, count: rows.length, startDate, endDate, basis: basis ?? "cash" });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // Read-only and GET-only, so a dashboard can be granted it without also
  // getting tc_request's write and delete access.
  server.registerTool(
    "list_transactions_by_account",
    {
      description:
        "Read-only. Every transaction for the given account IDs (e.g. management fee sub-accounts) dated " +
        "between startDate and endDate inclusive, newest first. Voided transactions are left out.",
      inputSchema: {
        accountIds: z.array(z.number().int()).min(1).max(50).describe("Account IDs to include"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First date, YYYY-MM-DD"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last date, YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountIds, startDate, endDate }) => {
      try {
        const filters = accountIds.map((id) => `filter[account_id][]=${id}`).join("&");
        type Page = {
          data?: Array<{ id?: string; attributes?: Record<string, unknown> }>;
          meta?: { pagination?: { total_pages?: number } };
        };
        const fetchPage = (page: number) =>
          client.request("GET", `/transactions?${filters}&sort=-date,-id&page=${page}`) as Promise<Page>;

        const rows: Record<string, unknown>[] = [];
        let page = 1;
        let totalPages = 1;
        let reachedStart = false;
        // TenantCloud has no date filter here and pages are fixed at 20 rows, so walk
        // newest-first, four pages at a time, until a page ends before startDate.
        while (!reachedStart && page <= totalPages && page <= 400) {
          const batch = await Promise.all(
            [0, 1, 2, 3].filter((i) => page + i <= totalPages || page === 1).map((i) => fetchPage(page + i)),
          );
          for (const raw of batch) {
            totalPages = raw.meta?.pagination?.total_pages ?? totalPages;
            const items = raw.data ?? [];
            for (const item of items) {
              const a = item.attributes ?? {};
              const date = String(a["date"] ?? "").slice(0, 10);
              if (date < startDate) reachedStart = true;
              if (date < startDate || date > endDate || a["void_at"]) continue;
              rows.push(
                compact({
                  id: Number(item.id),
                  date,
                  accountId: a["account_id"],
                  propertyId: a["property_id"],
                  amount: Number(a["amount"] ?? 0),
                  paid: Number(a["paid"] ?? 0),
                  balance: Number(a["balance"] ?? 0),
                  paidAt: a["paid_at"] ? String(a["paid_at"]).slice(0, 10) : undefined,
                }),
              );
            }
            if (items.length === 0) reachedStart = true;
          }
          page += batch.length;
        }
        return toolSuccess({ rows, count: rows.length, startDate, endDate });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
