import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { isValidRoutingNumber, MercuryClient, type MercuryRecipient } from "../src/client.js";
import { createServer } from "../src/server.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

function fakeMercury(existing: MercuryRecipient[] = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body as string | undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.includes("/recipients")) {
      return jsonResponse({ recipients: existing });
    }
    if (method === "POST" && url.endsWith("/recipients")) {
      const sent = JSON.parse(body!) as Record<string, unknown>;
      return jsonResponse({ id: "rcp-new", status: "active", ...sent });
    }
    return jsonResponse({ errors: { message: "not found" } }, 404);
  }) as typeof fetch;
  const client = new MercuryClient({ token: "test-token", fetch: fetchImpl });
  return { calls, client };
}

async function connect(client: MercuryClient) {
  const server = createServer(async () => client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientTransport);
  return mcp;
}

const base = {
  name: "Jane Doe Plumbing",
  emails: ["j@example.com"],
  accountNumber: "0000123456",
  routingNumber: "072000326",
  electronicAccountType: "businessChecking",
};

describe("routing number validation", () => {
  it("accepts valid ABA numbers and rejects bad checksums", () => {
    expect(isValidRoutingNumber("072000326")).toBe(true);
    expect(isValidRoutingNumber("044000024")).toBe(true);
    expect(isValidRoutingNumber("072000327")).toBe(false);
    expect(isValidRoutingNumber("72000326")).toBe(false);
  });
});

describe("mercury_create_ach_recipient", () => {
  it("sends account and routing numbers as strings with leading zeros intact", async () => {
    const { calls, client } = fakeMercury();
    const mcp = await connect(client);

    const result = await mcp.callTool({ name: "mercury_create_ach_recipient", arguments: base });

    expect(result.isError).toBeFalsy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.mercury.com/api/v1/recipients");
    expect(post.body).toContain('"accountNumber":"0000123456"');
    expect(post.body).toContain('"routingNumber":"072000326"');
    expect(JSON.parse(post.body!)).toMatchObject({ defaultPaymentMethod: "ach", emails: ["j@example.com"] });
  });

  it("refuses to create a duplicate by name or by account+routing", async () => {
    const existing: MercuryRecipient[] = [
      {
        id: "rcp-1",
        name: "Someone Else",
        status: "active",
        electronicRoutingInfo: { accountNumber: "0000123456", routingNumber: "072000326" },
      },
    ];
    const { calls, client } = fakeMercury(existing);
    const mcp = await connect(client);

    const result = await mcp.callTool({ name: "mercury_create_ach_recipient", arguments: base });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects malformed account numbers without calling Mercury", async () => {
    const { calls, client } = fakeMercury();
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: "mercury_create_ach_recipient",
      arguments: { ...base, accountNumber: "#10200000148144." },
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("exposes no payment tools", async () => {
    const { client } = fakeMercury();
    const mcp = await connect(client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "mercury_check_connection",
      "mercury_create_ach_recipient",
      "mercury_get_recipient",
      "mercury_list_recipients",
    ]);
  });
});
