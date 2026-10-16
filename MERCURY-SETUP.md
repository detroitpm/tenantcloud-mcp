# Mercury in Claude (recipients only)

`packages/mercury` is a small local connector that lets Claude list, read and **create** Mercury recipients. It has **no payment tools**: it can't send, approve or schedule money.

It runs on your computer, not in the cloud, because Mercury only accepts Read and Write tokens from IP addresses you've allowlisted. Your office or home internet connection gives you a stable address to allowlist.

## Setup (about 5 minutes)

You need Node.js LTS from [nodejs.org](https://nodejs.org) and this repo in a permanent folder (see [TEAM-SETUP.md](TEAM-SETUP.md) for how to download it).

- **Windows:** double-click **`setup-mercury-windows.cmd`**.
- **Mac:** `bash ~/tools/tenantcloud-mcp/setup-mercury.sh`

The script:

1. builds the connector and adds it to the Claude desktop app (and Claude Code, if installed);
2. copies this computer's public IP to your clipboard and opens Mercury's API token page;
3. waits while you create a **Read and Write** token with that IP allowlisted, then copy it;
4. asks you to paste the token (it doesn't show on screen), checks it works, and saves it in Windows Credential Manager or the Mac Keychain. The token is never written to a file or to this repo.

Then fully quit and reopen Claude and ask: *"List our Mercury recipients."*

## If it stops working

- **HTTP 403:** your internet provider probably changed your public IP. Re-run the setup script: it shows the new IP. Add it to the token's allowlist in Mercury (or make a new token), then paste the token again.
- **HTTP 401:** the token was revoked or mistyped. Re-run the setup script and paste a new one.

## Tools

| Tool | What it does |
| --- | --- |
| `mercury_check_connection` | Confirms the token works (lists account names only) |
| `mercury_list_recipients` | All recipients, with account numbers masked unless asked for in full |
| `mercury_get_recipient` | One recipient, exactly as Mercury returns it |
| `mercury_create_ach_recipient` | Adds an ACH recipient. Keeps account and routing numbers as text (leading zeros kept), checks the routing number checksum, and refuses duplicates by name or by account plus routing number |
