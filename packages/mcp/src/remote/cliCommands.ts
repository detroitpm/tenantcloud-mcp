import { CdpTokenProvider } from "tenantcloud-client/cdp";

/** Minimal --flag value parser for the remote subcommands. */
export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "";
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * `tc-mcp login --remote <url> --email <email> --code <invite code>`
 * Runs the local browser sign-in, then uploads the token set to the hosted
 * server's /pair endpoint instead of the OS credential store.
 */
export async function pairWithRemote(remoteUrl: string, email: string, code: string): Promise<number> {
  if (!remoteUrl || !email || !code) {
    console.error("Usage: tc-mcp login --remote <server-url> --email <email> --code <invite-code>");
    return 1;
  }

  console.log("Opening a browser window - sign in to TenantCloud with your own account...");
  const provider = new CdpTokenProvider({ allowInteractiveLogin: true });
  try {
    const tokens = await provider.interactiveLogin();
    if (!tokens) {
      console.error("Login failed: the window was closed, timed out, or no Chromium browser was found.");
      return 1;
    }

    const response = await fetch(`${remoteUrl.replace(/\/+$/, "")}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, ...tokens }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      console.error(`Pairing failed (${response.status}): ${body.error ?? "unknown error"}`);
      return 1;
    }

    console.log(`Paired with ${remoteUrl} as ${email}. You can now use the connector in Claude.`);
    return 0;
  } finally {
    provider.dispose();
  }
}

/**
 * `tc-mcp invite <email> --server <url> [--admin-key <key>]`
 * Admin helper: creates (or re-invites) a teammate and prints their invite code.
 */
export async function inviteTeammate(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const email = positional[0];
  const server = flags["server"];
  const adminKey = flags["admin-key"] ?? process.env["TC_ADMIN_KEY"];

  if (!email || !server || !adminKey) {
    console.error("Usage: tc-mcp invite <email> --server <url> [--admin-key <key>]");
    console.error("  (the admin key can also come from the TC_ADMIN_KEY environment variable)");
    return 1;
  }

  const response = await fetch(`${server.replace(/\/+$/, "")}/admin/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ email }),
  });
  const body = (await response.json().catch(() => ({}))) as { email?: string; inviteCode?: string; error?: string };
  if (!response.ok || !body.inviteCode) {
    console.error(`Invite failed (${response.status}): ${body.error ?? "unknown error"}`);
    return 1;
  }

  console.log(`Invited ${body.email}. Send them this (the code is shown only once):`);
  console.log("");
  console.log(`  1. Add the connector in Claude: ${server}/mcp`);
  console.log(`     Sign in with email ${body.email} and invite code ${body.inviteCode}`);
  console.log(`  2. Pair your TenantCloud account (one time, on your computer, after running setup.sh from TEAM-SETUP.md).`);
  console.log(`     Never use "npx tc-mcp": that npm name is an unrelated package.`);
  console.log(`     node ~/tools/tenantcloud-mcp/packages/mcp/dist/cli.js login --remote ${server} --email ${body.email} --code ${body.inviteCode}`);
  return 0;
}
