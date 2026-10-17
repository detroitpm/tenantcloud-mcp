# Team setup: TenantCloud in Claude

This is our private copy of an unofficial TenantCloud connector (originally by Eric Ma, `ericmanyc/tenantcloud-client-ts`). It was reviewed on 2026-10-05.

**Do not** use `npx tc-mcp`, which you may see online. That name on npm belongs to an unrelated project. Only install from this repo.

## Before you start

- Access to this GitHub repo (ask Kirtan, then accept the email invitation)
- The **Claude desktop app** or **Claude Code** installed
- **Node.js**: download the **LTS** version from [nodejs.org](https://nodejs.org) and install it with the default options
- Your **own TenantCloud team login**. Don't use anyone else's.

## Windows setup (about 5 minutes)

You don't need Git.

1. On this repo's GitHub page, click the green **Code** button, then **Download ZIP**.
2. Open your Downloads folder, right-click the ZIP, and choose **Extract All**.
3. Move the extracted folder somewhere permanent, for example `C:\Users\<you>\tools\tenantcloud-mcp`. **Leave it there afterwards:** Claude runs the tool from this folder, so moving or deleting it breaks the connection.
4. Open the folder and **double-click `setup-windows.cmd`**.
   - If a blue "Windows protected your PC" box appears, click **More info** → **Run anyway**.
   - If that doesn't work, open PowerShell from the Start menu and paste this (adjust the path if your folder is elsewhere):
     ```powershell
     Get-ChildItem "$HOME\tools\tenantcloud-mcp" -Recurse | Unblock-File; powershell -ExecutionPolicy Bypass -File "$HOME\tools\tenantcloud-mcp\setup.ps1"
     ```
5. The script builds the tool, connects it to Claude, and opens a TenantCloud sign-in window (in Edge or Chrome). Sign in as usual. Your login is saved in Windows Credential Manager.
6. **Fully quit Claude** (right-click its icon by the clock → Quit), then reopen it.

## Mac setup (about 5 minutes)

Open Terminal and paste these two commands, one at a time:

```bash
git clone https://github.com/detroitpm/tenantcloud-mcp.git ~/tools/tenantcloud-mcp
```

```bash
bash ~/tools/tenantcloud-mcp/setup.sh
```

If GitHub asks you to sign in, use your GitHub account. If the Mac offers to install developer tools for `git`, click **Install**, then run the first command again. The script opens a TenantCloud sign-in window, and your login is saved in your Mac's Keychain. Then fully quit Claude Code (Cmd+Q) and reopen it.

## Check it worked

Ask Claude: *"How many properties do we have in TenantCloud?"*

If a script stops with a message (for example "Node.js isn't installed"), do what it says, then run the script again.

## Ground rules

- The tool acts as **you** in TenantCloud, and it can make real changes (payments, leases, messages, deletions). Have Claude show you what it will do before anything is changed.
- Logged out? Run the setup script again. It's safe to re-run.
- Updates: download the new ZIP (Windows) or run `git pull` in the folder (Mac), then run the setup script again.
