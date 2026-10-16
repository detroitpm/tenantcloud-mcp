export const MERCURY_API_BASE = "https://api.mercury.com/api/v1";

export class MercuryError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "MercuryError";
  }
}

export type ElectronicAccountType = "businessChecking" | "businessSavings" | "personalChecking" | "personalSavings";

export interface MercuryAddress {
  address1: string;
  address2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface NewAchRecipient {
  name: string;
  emails: string[];
  nickname?: string;
  /** Kept as a string end to end so leading zeros survive. */
  accountNumber: string;
  routingNumber: string;
  electronicAccountType: ElectronicAccountType;
  address?: MercuryAddress;
}

export interface MercuryRecipient {
  id: string;
  name: string;
  status?: string;
  emails?: string[];
  nickname?: string | null;
  defaultPaymentMethod?: string;
  electronicRoutingInfo?: {
    accountNumber: string;
    routingNumber: string;
    electronicAccountType?: string;
    bankName?: string;
  } | null;
  [key: string]: unknown;
}

/** ABA routing number: 9 digits whose weighted sum (3,7,1 repeating) is a multiple of 10. */
export function isValidRoutingNumber(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) {
    return false;
  }
  const d = [...routing].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export function isValidAccountNumber(account: string): boolean {
  return /^\d{4,17}$/.test(account);
}

const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** Existing recipients that look like the same payee: same name, or same account at the same bank. */
export function findDuplicates(existing: MercuryRecipient[], candidate: NewAchRecipient): MercuryRecipient[] {
  return existing.filter((r) => {
    if (r.status === "deleted") {
      return false;
    }
    if (normalizeName(r.name) === normalizeName(candidate.name)) {
      return true;
    }
    const info = r.electronicRoutingInfo;
    return info?.accountNumber === candidate.accountNumber && info?.routingNumber === candidate.routingNumber;
  });
}

export interface MercuryClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Thin Mercury REST client. Only accounts (for a connection check) and recipients; no payment endpoints. */
export class MercuryClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MercuryClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? MERCURY_API_BASE;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error body; keep the raw text
    }

    if (!response.ok) {
      let hint = "";
      if (response.status === 401) {
        hint = " The Mercury token is missing, wrong, or revoked. Run the Mercury setup again to save a new one.";
      } else if (response.status === 403) {
        hint =
          " Mercury refused the request. Read and Write tokens only work from allowlisted IP addresses: check this computer's public IP is on the token's allowlist.";
      }
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new MercuryError(`Mercury ${method} ${path} failed (HTTP ${response.status}): ${detail}.${hint}`, response.status, parsed);
    }
    return parsed as T;
  }

  async listAccounts(): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ accounts?: Array<Record<string, unknown>> }>("GET", "/accounts");
    return result.accounts ?? [];
  }

  /** All recipients, following cursor pagination. */
  async listRecipients(): Promise<MercuryRecipient[]> {
    const all: MercuryRecipient[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "1000", order: "asc" });
      if (startAfter) {
        query.set("start_after", startAfter);
      }
      const page = await this.request<{ recipients?: MercuryRecipient[] }>("GET", `/recipients?${query}`);
      const batch = page.recipients ?? [];
      all.push(...batch);
      if (batch.length < 1000) {
        return all;
      }
      startAfter = batch[batch.length - 1]!.id;
    }
  }

  async getRecipient(id: string): Promise<MercuryRecipient> {
    return this.request<MercuryRecipient>("GET", `/recipient/${encodeURIComponent(id)}`);
  }

  async createAchRecipient(input: NewAchRecipient): Promise<MercuryRecipient> {
    const electronicRoutingInfo: Record<string, unknown> = {
      accountNumber: input.accountNumber,
      routingNumber: input.routingNumber,
      electronicAccountType: input.electronicAccountType,
    };
    if (input.address) {
      electronicRoutingInfo["address"] = input.address;
    }
    const body: Record<string, unknown> = {
      name: input.name,
      emails: input.emails,
      defaultPaymentMethod: "ach",
      electronicRoutingInfo,
    };
    if (input.nickname) {
      body["nickname"] = input.nickname;
    }
    return this.request<MercuryRecipient>("POST", "/recipients", body);
  }
}
