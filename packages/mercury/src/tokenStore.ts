const SERVICE = "mercury-mcp";
const ACCOUNT = "api-token";

async function entry(): Promise<import("@napi-rs/keyring").Entry> {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(SERVICE, ACCOUNT);
}

/**
 * The Mercury API token, from the MERCURY_TOKEN environment variable if set,
 * otherwise from the OS credential store (Credential Manager / Keychain).
 */
export async function loadToken(): Promise<string | null> {
  const fromEnv = process.env["MERCURY_TOKEN"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return (await entry()).getPassword()?.trim() || null;
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  (await entry()).setPassword(token.trim());
}

export async function deleteToken(): Promise<void> {
  try {
    (await entry()).deletePassword();
  } catch {
    // Deleting a non-existent credential is not an error
  }
}
