import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  findDuplicates,
  isValidAccountNumber,
  isValidRoutingNumber,
  MercuryClient,
  type NewAchRecipient,
} from "./client.js";
import { VERSION } from "./version.js";

function toolSuccess(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Last four digits only, for summaries that don't need the full number. */
const last4 = (value: string | undefined) => (value ? `••${value.slice(-4)}` : null);

const INSTRUCTIONS =
  "Mercury bank recipients for 3 GEN LLC. These tools can list, read and create recipients only; " +
  "there are no payment tools, and you must not try to send money. Account and routing numbers are " +
  "strings: pass them exactly as given, never as numbers, and never drop leading zeros. Before creating " +
  "several recipients, create one, show the user the result, and wait for their OK.";

export function createServer(getClient: () => Promise<MercuryClient>): McpServer {
  const server = new McpServer({ name: "mercury-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "mercury_check_connection",
    {
      description:
        "Check the Mercury API token works by listing account names (no balances or numbers). Use first if other tools fail.",
      inputSchema: {},
    },
    async () => {
      try {
        const accounts = await (await getClient()).listAccounts();
        return toolSuccess({ connected: true, accounts: accounts.map((a) => ({ name: a["name"], status: a["status"] })) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "mercury_list_recipients",
    {
      description:
        "List all Mercury recipients with id, name, status and masked account details. Set includeFullNumbers to compare full account and routing numbers (for verification only).",
      inputSchema: {
        includeFullNumbers: z.boolean().optional().describe("Return full account numbers instead of the last 4 digits"),
      },
    },
    async ({ includeFullNumbers }) => {
      try {
        const recipients = await (await getClient()).listRecipients();
        return toolSuccess({
          total: recipients.length,
          recipients: recipients.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            emails: r.emails,
            defaultPaymentMethod: r.defaultPaymentMethod,
            accountNumber: includeFullNumbers
              ? r.electronicRoutingInfo?.accountNumber
              : last4(r.electronicRoutingInfo?.accountNumber),
            routingNumber: r.electronicRoutingInfo?.routingNumber,
            electronicAccountType: r.electronicRoutingInfo?.electronicAccountType,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "mercury_get_recipient",
    {
      description: "Get one Mercury recipient by id, exactly as the API returns it (including full account details).",
      inputSchema: { id: z.string().describe("Recipient id from mercury_list_recipients") },
    },
    async ({ id }) => {
      try {
        return toolSuccess(await (await getClient()).getRecipient(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "mercury_create_ach_recipient",
    {
      description:
        "Create a Mercury recipient paid by ACH. Refuses if a recipient with the same name, or the same account and routing number, already exists (set allowDuplicate only if the user explicitly confirms). Validates the routing number checksum. Does NOT send any payment.",
      inputSchema: {
        name: z.string().min(1).describe("Recipient (payee) name"),
        emails: z.array(z.string().email()).min(1).describe("Email address(es) Mercury notifies about payments"),
        nickname: z.string().optional(),
        accountNumber: z.string().describe("Bank account number as a string, exactly as given (keep leading zeros)"),
        routingNumber: z.string().describe("9-digit ABA routing number as a string, exactly as given"),
        electronicAccountType: z.enum(["businessChecking", "businessSavings", "personalChecking", "personalSavings"]),
        address: z
          .object({
            address1: z.string(),
            address2: z.string().optional(),
            city: z.string(),
            region: z.string().describe("State, e.g. MI"),
            postalCode: z.string(),
            country: z.string().describe("Two-letter country code, e.g. US"),
          })
          .optional()
          .describe("Recipient's mailing address, if Mercury asks for one"),
        allowDuplicate: z.boolean().optional(),
      },
    },
    async ({ allowDuplicate, address, nickname, ...fields }) => {
      try {
        if (!isValidRoutingNumber(fields.routingNumber)) {
          return toolError(`Routing number "${fields.routingNumber}" is not a valid 9-digit ABA routing number.`);
        }
        if (!isValidAccountNumber(fields.accountNumber)) {
          return toolError(`Account number for ${fields.name} must be 4-17 digits with nothing else in it.`);
        }

        const input: NewAchRecipient = { ...fields };
        if (nickname) {
          input.nickname = nickname;
        }
        if (address) {
          const { address2, ...rest } = address;
          input.address = address2 ? { ...rest, address2 } : rest;
        }

        const client = await getClient();
        if (!allowDuplicate) {
          const duplicates = findDuplicates(await client.listRecipients(), input);
          if (duplicates.length > 0) {
            return toolError(
              `Not created: ${fields.name} looks like it already exists in Mercury (${duplicates
                .map((d) => `${d.name}, id ${d.id}`)
                .join("; ")}). Skip it, or confirm with the user before retrying with allowDuplicate.`,
            );
          }
        }

        const created = await client.createAchRecipient(input);
        const info = created.electronicRoutingInfo;
        return toolSuccess({
          created,
          check: {
            nameMatches: created.name === input.name,
            accountNumberMatches: info?.accountNumber === input.accountNumber,
            routingNumberMatches: info?.routingNumber === input.routingNumber,
          },
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export async function runServer(getClient: () => Promise<MercuryClient>): Promise<void> {
  const server = createServer(getClient);
  await server.connect(new StdioServerTransport());
}
