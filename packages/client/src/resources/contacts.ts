/**
 * Contacts (writes). Reads stay on `client.contacts` (PaginatedSource); this
 * client adds create/update/invite/delete and contact insurances.
 *
 * The JSON:API resource type for a contact is `userClient` (note camelCase),
 * and several attributes are camelCase too (firstName, lastName, isCompany).
 *
 * Endpoints:
 *   POST   /contacts                 create
 *   GET    /contacts?filter[id]={id} read one (GET /contacts/{id} 404s)
 *   PATCH  /landlord/tenants/{id}    update a tenant      - plain body, not JSON:API
 *   PATCH  /professionals/{id}       update a professional - plain body, not JSON:API
 *   DELETE /contacts/{id}
 *   POST   /contacts/invite          invite to the tenant portal
 *   GET/POST /contacts/insurances (+ /{id})
 */
import { parseContact, type TcContact } from "../models.js";
import {
  jsonApiBody,
  parseJsonApiList,
  parseJsonApiOne,
  withQuery,
  type JsonApiList,
  type JsonApiRecord,
  type TcHttp,
} from "./jsonApi.js";

const CONTACT_TYPE = "userClient";

/** Update endpoint per contact role. */
const UPDATE_PATHS: Record<string, string> = {
  tenant: "/landlord/tenants",
  professional: "/professionals",
};

export class ContactsClient {
  constructor(private readonly http: TcHttp) {}

  async get(id: number, signal?: AbortSignal): Promise<TcContact | null> {
    const raw = await this.getRaw(id, signal);
    return raw ? parseContact(raw) : null;
  }

  private async getRaw(id: number, signal?: AbortSignal): Promise<JsonApiRecord | null> {
    const { items } = parseJsonApiList(
      await this.http.request("GET", withQuery("/contacts", { "filter[id]": id }), { signal }),
    );
    return items.find((item) => item.id === id) ?? null;
  }

  /**
   * Create a contact. Attribute keys are camelCase for names
   * (firstName, lastName, middleName, company, isCompany) and the email/phone.
   */
  async create(attributes: Record<string, unknown>, signal?: AbortSignal): Promise<TcContact | null> {
    const one = parseJsonApiOne(
      await this.http.request("POST", "/contacts", {
        body: jsonApiBody(CONTACT_TYPE, attributes),
        signal,
      }),
    );
    return one ? parseContact(one) : null;
  }

  /**
   * Update a contact. TenantCloud has no generic contact PATCH route, so this
   * looks up the contact's role and PATCHes the role-specific endpoint, which
   * takes the attributes as a plain body and silently ignores a JSON:API envelope.
   */
  async update(
    id: number,
    attributes: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TcContact | null> {
    const existing = await this.getRaw(id, signal);
    if (!existing) {
      throw new Error(`Contact ${id} not found`);
    }
    const path = UPDATE_PATHS[String(existing["role"])];
    if (!path) {
      throw new Error(`Updating contacts with role '${String(existing["role"])}' is not supported`);
    }
    const updated = await this.http.request<Record<string, unknown> | null>("PATCH", `${path}/${id}`, {
      body: attributes,
      signal,
    });
    return updated ? parseContact(updated) : null;
  }

  async delete(id: number, signal?: AbortSignal): Promise<void> {
    await this.http.request("DELETE", `/contacts/${id}`, { signal });
  }

  /** Invite a contact to the tenant portal. */
  invite(attributes: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.http.request("POST", "/contacts/invite", {
      body: jsonApiBody(CONTACT_TYPE, attributes),
      signal,
    });
  }

  listInsurances(
    options: { page?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<JsonApiList> {
    return this.http
      .request("GET", withQuery("/contacts/insurances", { page: options.page }), {
        signal: options.signal,
      })
      .then(parseJsonApiList);
  }

  async addInsurance(
    attributes: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonApiRecord | null> {
    return parseJsonApiOne(
      await this.http.request("POST", "/contacts/insurances", {
        body: jsonApiBody("contact_insurance", attributes),
        signal,
      }),
    );
  }
}
