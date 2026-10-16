# One-step setup of the Mercury recipients connector (mercury-mcp) on Windows, for the Claude desktop app and Claude Code.
# Easiest: double-click setup-mercury-windows.cmd.
# Safe to re-run: it rebuilds, re-registers, and lets you replace the saved token.
$ErrorActionPreference = "Stop"

$RepoDir = $PSScriptRoot
$Cli = Join-Path $RepoDir "packages\mercury\dist\cli.js"

function Say($msg)  { Write-Host "`n$msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`nStopped: $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
function Has($cmd)  { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Say "1/5  Checking this computer has what it needs..."
if (-not (Has "node")) { Fail "Node.js isn't installed. Download the LTS version from https://nodejs.org, install it, then run this again." }
$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) { Fail "Node.js is too old (version $NodeMajor). Install the LTS version from https://nodejs.org, then run this again." }
$HasClaudeCode = Has "claude"
Write-Host "OK: Node $(& node -v)."

Say "2/5  Downloading supporting software and building (1-2 minutes)..."
Set-Location $RepoDir
# npm.cmd (not npm) sidesteps PowerShell's script-blocking policy for npm.ps1.
& npm.cmd ci --cache "$env:TEMP\tc-mcp-npm-cache" --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "Downloading supporting software failed (see the messages above)." }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { Fail "The build failed (see the messages above)." }
if (-not (Test-Path $Cli)) { Fail "The build finished but $Cli is missing." }

Say "3/5  Connecting it to Claude..."
& node "$Cli" install claude-desktop
if ($LASTEXITCODE -ne 0) { Fail "Couldn't connect it to the Claude desktop app (see the messages above)." }
if ($HasClaudeCode) {
  & node "$Cli" install claude-code
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't connect it to Claude Code (see the messages above)." }
}

& node "$Cli" check 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  $replace = Read-Host "`nA working Mercury token is already saved. Replace it? (y/N)"
  if ($replace -notmatch '^[yY]') {
    Say "Done. Fully quit Claude (right-click its icon in the taskbar > Quit) and reopen it."
    Read-Host "Press Enter to close"; exit 0
  }
}

Say "4/5  Create the Mercury API token"
$Ip = (& node "$Cli" my-ip).Trim()
if ($LASTEXITCODE -ne 0 -or -not $Ip) { Fail "Couldn't look up this computer's public IP address." }
Set-Clipboard -Value $Ip
Write-Host "This computer's public IP is $Ip (already copied to your clipboard)."
Write-Host "Mercury is opening in your browser. There:"
Write-Host "  1. Go to Settings > API Tokens and click to add a token."
Write-Host "  2. Choose 'Read and Write' (needed to add recipients)."
Write-Host "  3. When it asks for allowed IP addresses, paste $Ip (Ctrl+V)."
Write-Host "  4. Copy the token Mercury shows you. It is shown only once."
Start-Process "https://app.mercury.com/settings/tokens"
Read-Host "`nPress Enter once you've copied the token"

Say "5/5  Saving the token (it's checked first, then stored in Windows Credential Manager)..."
& node "$Cli" set-token
if ($LASTEXITCODE -ne 0) { Fail "The token didn't work (see the message above). Run this again to retry." }

Say "Done. Fully quit Claude (right-click its icon in the taskbar > Quit), reopen it, and ask: `"List our Mercury recipients.`""
Read-Host "Press Enter to close"
