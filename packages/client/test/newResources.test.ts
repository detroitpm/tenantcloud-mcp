import { describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import { TcClient } from "../src/tcClient.js";
import { parseTask } from "../src/resources/productivity.js";
import { parseFile } from "../src/resources/files.js";
import { parseJsonApiList, normalizeItem } from "../src/resources/jsonApi.js";
import { parseMaintenanceRequest } from "../src/resources/maintenance.js";
import { parsePropertyEquipment, parsePropertyKey } from "../src/resources/portfolio.js";
import { parseTcDateOrNull } from "../src/json.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("productivity & files parsers", () => {
  it("parses a task", () => {
    const t = parseTask({
      id: 3,
      title: "Renew CO",
      text: "annual",
      is_recurring: false,
      is_resolved: false,
      is_full_day: true,
      remind_date: "2026-06-30T13:00:00.000000Z",
      created_at: "2026-06-01T00:00:00Z",
    });
    expect(t).toMatchObject({ id: 3, title: "Renew CO", isFullDay: true, isResolved: false });
    expect(t.remindDate).toBeInstanceOf(Date);
  });

  it("parses a file", () => {
    const f = parseFile({
      id: 8,
      sender_id: 100,
      parent_id: null,
      type: "lease",
      name: "lease.pdf",
      token: "abc",
      size: 1234,
      ext: "pdf",
      is_image: false,
      is_archived: false,
      file_url: "https://x/lease.pdf",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(f).toMatchObject({ id: 8, name: "lease.pdf", ext: "pdf", isImage: false, size: 1234 });
    expect(f.fileUrl).toBe("https://x/lease.pdf");
  });
});

describe("real-data robustness (found via live smoke test)", () => {
  it("parseTcDateOrNull treats [], '', and blanks as null instead of throwing", () => {
    expect(parseTcDateOrNull([])).toBeNull();
    expect(parseTcDateOrNull("")).toBeNull();
    expect(parseTcDateOrNull("   ")).toBeNull();
    expect(parseTcDateOrNull({})).toBeNull();
    // a real date string still parses
    expect(parseTcDateOrNull("2026-06-30")).toBeInstanceOf(Date);
  });

  it("parseMaintenanceRequest survives an empty-array date field", () => {
    const r = parseMaintenanceRequest({ id: 1, title: "x", available_on: [], due: [], status: "new" });
    expect(r.availableOn).toBeNull();
    expect(r.dueDate).toBeNull();
  });

  it("normalizeItem treats an empty-string id as 0 (aggregate/statistics resources)", () => {
    expect(normalizeItem({ type: "transaction_payment_statistics", id: "", attributes: { amount: 5 } })).toEqual({
      amount: 5,
      type: "transaction_payment_statistics",
      id: 0,
    });
  });
});

describe("portfolio parsers (synthetic data matching the live JSON:API shape)", () => {
  it("parses a property key (codes live in comment; property_id not echoed)", () => {
    const k = parsePropertyKey({
      id: "11",
      keyname: "Unit A Front Door",
      comment: "<p>Code - 0000</p>",
      type: 1,
      created_at: "2026-03-30T15:59:55.000000Z",
    });
    expect(k).toMatchObject({ id: 11, keyname: "Unit A Front Door", type: 1, typeLabel: "Main door" });
    expect(k.comment).toContain("0000");
    expect(k.createdAt).toBeInstanceOf(Date);
  });

  it("leaves typeLabel null for an unknown or absent key type", () => {
    expect(parsePropertyKey({ id: 1, keyname: "x", type: 99 }).typeLabel).toBeNull();
    expect(parsePropertyKey({ id: 2, keyname: "y" }).typeLabel).toBeNull();
  });

  it("parses property equipment with snake_case -> camelCase mapping", () => {
    const e = parsePropertyEquipment({
      id: "22",
      make: "Acme HVAC",
      property_id: 1,
      unit_id: 2,
      category_id: 3,
      model_number: null,
      vin_number: "SN-001",
      price: null,
      install_date: null,
      warranty_expiration_date: null,
      life_time_warranty: false,
      notes: null,
      created_at: "2025-12-01T14:44:03.000000Z",
      updated_at: "2025-12-01T14:44:03.000000Z",
    });
    expect(e).toMatchObject({
      id: 22,
      make: "Acme HVAC",
      propertyId: 1,
      unitId: 2,
      categoryId: 3,
      vinNumber: "SN-001",
      lifeTimeWarranty: false,
    });
    expect(e.installDate).toBeNull();
    expect(e.createdAt).toBeInstanceOf(Date);
  });
});

describe("portfolio client paths", () => {
  it("lists keys with a property_id filter and parses items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ type: "property_key", id: "1", attributes: { keyname: "Front Door", type: 1 } }],
        meta: { pagination: { total: 1, current_page: 1, per_page: 12, total_pages: 1 } },
      }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const { items, total } = await client.portfolio.keys.list({ propertyId: 123 });

    expect(total).toBe(1);
    expect(items[0]?.keyname).toBe("Front Door");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/property/keys");
    expect(url).toContain(`${encodeURIComponent("filter[property_id]")}=123`);
  });

  it("creates a key with property/unit sent as JSON:API relationships, not attributes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            type: "property_key",
            id: "77",
            attributes: { keyname: "Unit 1 Door", type: 1, comment: "<p>code</p>" },
            relationships: {
              property: { data: { type: "property", id: "862773" } },
              units: { data: { type: "units", id: "1392965" } },
            },
          },
        },
        201,
      ),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const key = await client.portfolio.keys.create({
      property_id: 862773,
      unit_id: 1392965,
      keyname: "Unit 1 Door",
      type: 1,
      comment: "<p>code</p>",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/property/keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        type: "property_key",
        attributes: { keyname: "Unit 1 Door", type: 1, comment: "<p>code</p>" },
        relationships: {
          avatar: { data: null },
          property: { data: { type: "property", id: "862773" } },
          unit: { data: { type: "units", id: "1392965" } },
        },
      },
    });
    expect(key).toMatchObject({ id: 77, keyname: "Unit 1 Door", propertyId: 862773, unitId: 1392965 });
  });

  it("creates a property-level key with the app's full relationship set (unit/avatar null)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            type: "property_key",
            id: "78",
            attributes: { keyname: "106 Front Door", type: 1, comment: "<p>code</p>" },
            relationships: { property: { data: { type: "property", id: "862774" } }, unit: { data: null } },
          },
        },
        201,
      ),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const key = await client.portfolio.keys.create({
      property_id: 862774,
      keyname: "106 Front Door",
      type: 1,
      comment: "<p>code</p>",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    // Byte-identical in shape to what app.tenantcloud.com POSTs: every
    // relationship is present, unset ones carry an explicit null linkage.
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        type: "property_key",
        attributes: { keyname: "106 Front Door", type: 1, comment: "<p>code</p>" },
        relationships: {
          avatar: { data: null },
          property: { data: { type: "property", id: "862774" } },
          unit: { data: null },
        },
      },
    });
    expect(key).toMatchObject({ id: 78, propertyId: 862774, unitId: null });
  });

  it("updates a key without touching relationships when none are given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { type: "property_key", id: "77", attributes: { keyname: "Back Door", type: 2 } },
      }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const key = await client.portfolio.keys.update(77, { keyname: "Back Door", type: 2 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      data: { type: "property_key", id: "77", attributes: { keyname: "Back Door", type: 2 } },
    });
    expect(key).toMatchObject({ id: 77, propertyId: null, unitId: null });
  });

  it("creates equipment via the property_equipment JSON:API type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { data: { type: "property_equipment", id: "9", attributes: { make: "Carrier", property_id: 5 } } },
        201,
      ),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const eq = await client.portfolio.equipment.create({ property_id: 5, make: "Carrier" });

    expect(eq?.id).toBe(9);
    expect(eq?.make).toBe("Carrier");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/property/equipment");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { type: "property_equipment", attributes: { property_id: 5, make: "Carrier" } },
    });
  });
});

describe("maintenance list filters (status/priority names become numeric codes)", () => {
  it("converts a status name to its filter code in the request URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [],
        meta: { pagination: { total: 0, current_page: 1, per_page: 12, total_pages: 1 } },
      }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await client.maintenance.list({ status: "resolved", priority: "critical" });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`${encodeURIComponent("filter[statuses][0]")}=3`);
    expect(url).toContain(`${encodeURIComponent("filter[priority]")}=4`);
  });

  it("passes an unrecognized status through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [], meta: { pagination: { total: 0, current_page: 1, per_page: 12, total_pages: 1 } } }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await client.maintenance.list({ status: "waiting_on_parts" });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`${encodeURIComponent("filter[statuses][0]")}=waiting_on_parts`);
  });
});

describe("parseJsonApiList envelope tolerance", () => {
  it("treats a single-object data envelope as a one-item list (statistics endpoints)", () => {
    const { items, pagination } = parseJsonApiList({
      data: { type: "transaction_statistics", id: 0, attributes: { amount: 100, balance: 25 } },
    });
    expect(items).toEqual([{ amount: 100, balance: 25, type: "transaction_statistics", id: 0 }]);
    expect(pagination.total).toBe(1);
  });

  it("returns an empty list for null/absent data", () => {
    expect(parseJsonApiList({ data: null }).items).toEqual([]);
    expect(parseJsonApiList({}).items).toEqual([]);
  });
});

describe("financials statistics survive a single-object response", () => {
  it("does not throw when /transactions/statistics returns one object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { type: "transaction_statistics", id: 0, attributes: { amount: 5, balance: 1, currency: "USD", paid: 4 } } }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const stats = await client.financials.statistics({ property_id: 10 });

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ amount: 5, balance: 1 });
  });
});

describe("timeline & notes (numeric entity codes, non-JSON:API)", () => {
  const timelinePayload = {
    pagination: { total: 2, current_page: 1 },
    list: [
      { id: 1, entity_type: "Note", action: 5, message_data: { text: "hi" } },
      { id: 2, entity_type: "Note", action: 5, message_data: { text: "yo" } },
    ],
    unread_count: 0,
    counts: {},
  };

  it("lists notes via GET /timeline with filter=notes and lease code 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(timelinePayload));
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const { items, total } = await client.productivity.listNotes("lease", 1530700);

    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/timeline?");
    expect(url).toContain("entity_id=1530700");
    expect(url).toContain("entity_type=1");
    expect(url).toContain("filter=notes");
  });

  it("maps entity type names to numeric codes (contact=2, lead=8)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(timelinePayload));
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await client.productivity.listTimeline("lead", 7, { filter: "activity" });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("entity_type=8");
    expect(url).toContain("filter=activity");
    await expect(client.productivity.listTimeline("bogus" as never, 1)).rejects.toThrow(
      /Unknown timeline entity type/,
    );
  });

  it("creates a note with a plain resource_id/resource_type body (no JSON:API envelope)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 42, text: "note text", resource_id: 1530700 }, 201),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await client.productivity.createNote("lease", 1530700, { text: "note text" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "note text",
      resource_id: 1530700,
      resource_type: 1,
    });
  });

  it("updates a note via PUT /notes/{id}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 42, text: "edited" }));
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await client.productivity.updateNote(42, { text: "edited" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/notes/42");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ text: "edited", id: 42 });
  });
});

describe("new write paths", () => {
  it("creates a task via JSON:API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { data: { type: "task", id: "9", attributes: { title: "T", remind_date: "2026-06-30", is_full_day: true } } },
        201,
      ),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const task = await client.productivity.createTask({ title: "T", remind_date: "2026-06-30" });

    expect(task?.id).toBe(9);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/tasks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { type: "task", attributes: { title: "T", remind_date: "2026-06-30" } },
    });
  });

  it("creates a contact with the userClient JSON:API type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { data: { type: "userClient", id: "55", attributes: { firstName: "Jane", lastName: "Doe", email: "j@x.com" } } },
        201,
      ),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const contact = await client.crm.create({ firstName: "Jane", lastName: "Doe", email: "j@x.com" });

    expect(contact?.id).toBe(55);
    expect(contact?.firstName).toBe("Jane");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tenantcloud.com/contacts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { type: "userClient", attributes: { firstName: "Jane", lastName: "Doe", email: "j@x.com" } },
    });
  });

  it.each([
    ["professional", "https://api.tenantcloud.com/professionals/56"],
    ["tenant", "https://api.tenantcloud.com/landlord/tenants/56"],
  ])("updates a %s contact via its role endpoint with a plain body", async (role, expectedUrl) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ type: "userClient", id: "56", attributes: { role, firstName: "Jane", phone: "" } }],
          meta: { pagination: { total: 1, current_page: 1, per_page: 12, total_pages: 1 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 56, role, firstName: "Jane", phone: "15550001111" }));
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const contact = await client.crm.update(56, { phone: "15550001111" });

    expect(contact?.phone1).toBe("15550001111");
    const [lookupUrl] = fetchMock.mock.calls[0]!;
    expect(lookupUrl).toBe(`https://api.tenantcloud.com/contacts?${encodeURIComponent("filter[id]")}=56`);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(expectedUrl);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ phone: "15550001111" });
  });

  it("rejects updating a contact whose role has no known update endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ type: "userClient", id: "57", attributes: { role: "owner" } }],
        meta: { pagination: { total: 1, current_page: 1, per_page: 12, total_pages: 1 } },
      }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    await expect(client.crm.update(57, { phone: "1" })).rejects.toThrow("role 'owner'");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists files and parses items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ type: "file", id: "1", attributes: { name: "a.pdf", ext: "pdf", is_image: false } }],
        meta: { pagination: { total: 1, current_page: 1, per_page: 100, total_pages: 1 } },
      }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const { items, pagination } = await client.files.list();

    expect(items[0]?.name).toBe("a.pdf");
    expect(pagination.total).toBe(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/files");
  });

  it("exposes owner agreements on the financials client", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [], meta: { pagination: { total: 0, current_page: 1, per_page: 100, total_pages: 1 } } }),
    );
    const client = new TcClient(new StaticTokenProvider("tok"), { fetch: fetchMock });

    const { items } = await client.financials.ownerAgreements();

    expect(items).toEqual([]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/owner_agreements");
  });
});
