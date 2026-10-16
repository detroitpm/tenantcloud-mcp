#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MercuryClient } from "./client.js";
import { runServer } from "./server.js";
import { deleteToken, loadToken, saveToken } from "./tokenStore.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

function printHelp(): void {
  console.log(`mercury-mcp v${VERSION} - Mercury recipients MCP server (no payment tools)`);
  console.log();
  console.log("Usage: mercury-mcp <command>");
  console.log();
  console.log("Commands:");
  console.log("  mcp                       Start the MCP server (stdio transport)");
  console.log("  my-ip                     Show this computer's public IP (for Mercury's token allowlist)");
  console.log("  set-token                 Paste a Mercury API token and save it in the OS credential store");
  console.log("  check                     Confirm the saved token works");
  console.log("  remove-token              Delete the saved token");
  console.log("  install claude-desktop    Register in Claude Desktop config");
  console.log("  install claude-code       Register in Claude Code via CLI");
}

async function clientOrThrow(): Promise<MercuryClient> {
  const token = await loadToken();
  if (!token) {
    throw new Error('No Mercury API token is saved. Run "mercury-mcp set-token" (or the Mercury setup script) first.');
  }
  return new MercuryClient({ token });
}

async function publicIp(): Promise<string> {
  const response = await fetch("https://api.ipify.org");
  if (!response.ok) {
    throw new Error(`Couldn't look up the public IP (HTTP ${response.status}).`);
  }
  return (await response.text()).trim();
}

/** Read a line from the terminal without echoing it, so the token never shows on screen. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input (e.g. from a setup script): just read it
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function check(): Promise<number> {
  const accounts = await (await clientOrThrow()).listAccounts();
  console.log(`Connected to Mercury. Accounts: ${accounts.map((a) => String(a["name"])).join(", ") || "(none)"}`);
  return 0;
}

async function setToken(): Promise<number> {
  const token = await promptHidden("Paste your Mercury API token (it won't show), then press Enter: ");
  if (!token) {
    console.error("No token entered; nothing saved.");
    return 1;
  }
  // Verify before saving so a typo doesn't replace a working token
  await new MercuryClient({ token }).listAccounts();
  await saveToken(token);
  console.log("Token works and is saved in this computer's credential store.");
  return 0;
}

function serverInvocation(): { command: string; args: string[] } {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  return { command: process.execPath, args: [cliPath, "mcp"] };
}

function claudeDesktopConfigPath(): string | null {
  switch (process.platform) {
    case "win32": {
      const appData = process.env["APPDATA"];
      return appData ? join(appData, "Claude", "claude_desktop_config.json") : null;
    }
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

async function install(target: string | undefined): Promise<number> {
  const { command, args } = serverInvocation();
  switch (target?.toLowerCase()) {
    case "claude-desktop": {
      const configPath = claudeDesktopConfigPath();
      if (!configPath) {
        console.error("Error: Could not determine Claude Desktop config location for this platform.");
        return 1;
      }
      await mkdir(dirname(configPath), { recursive: true });
      let root: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try {
          root = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        } catch {
          console.error(`Error: ${configPath} exists but is not valid JSON. Fix or remove it first.`);
          return 1;
        }
      }
      const servers = (root["mcpServers"] ??= {}) as Record<string, unknown>;
      servers["mercury-mcp"] = { command, args };
      const tempPath = configPath + ".tmp";
      await writeFile(tempPath, JSON.stringify(root, null, 2));
      await rename(tempPath, configPath);
      console.log(`Registered mercury-mcp in ${configPath}`);
      return 0;
    }
    case "claude-code": {
      await execFileAsync("claude", ["mcp", "remove", "mercury-mcp", "-s", "user"]).catch(() => undefined);
      await execFileAsync("claude", ["mcp", "add", "--scope", "user", "--transport", "stdio", "mercury-mcp", "--", command, ...args]);
      console.log("Registered mercury-mcp with Claude Code.");
      return 0;
    }
    default:
      console.error("Usage: mercury-mcp install <claude-desktop|claude-code>");
      return 1;
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command?.toLowerCase()) {
    case "mcp":
      await runServer(clientOrThrow);
      // Keep the process alive; the stdio transport closes it on disconnect
      return new Promise<number>(() => {});
    case "my-ip":
      console.log(await publicIp());
      return 0;
    case "set-token":
      return setToken();
    case "check":
      return check();
    case "remove-token":
      await deleteToken();
      console.log("Removed the saved Mercury token.");
      return 0;
    case "install":
      return install(rest[0]);
    case undefined:
      printHelp();
      return 0;
    default:
      printHelp();
      return 1;
  }
}

main().then(
  (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
