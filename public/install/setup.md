# VibeMon setup

Install hooks to send coding-agent summaries to the local Desktop App, the Web service, or both. Python 3 is required. Web uses Google login; agent-provider credentials remain on the machine running the hooks.

## 1. Prepare credentials

1. Sign in at [Account](https://vibemon.io/account).
2. Create a named token with `write` permission for hooks.
3. Create a separate `read` token for the Desktop App. The Web dashboard uses your Google login.
4. Select **Show token** to view and copy it. You can retrieve active tokens again from the same signed-in account.

Account shows your Google profile and active/revoked tokens. Delete unused tokens from this page; deletion immediately stops their API access without removing resource data. Older hash-only tokens become retrievable after their next successful use. If an unused older token's original value is lost, create a new token and delete the old entry.

Provide the write token through `VIBEMON_WRITE_TOKEN`, using your environment or secret manager. Interactive installation offers a hidden prompt. Do not put tokens in URLs or shell history. Existing user-chosen tokens must be replaced with generated tokens.

## 2. Install hooks

Desktop users can open **Settings → AI Tools → Install**. Set the write token independently of the App's Monitoring read token.

For a headless macOS or Linux installation:

```sh
curl -fsSL https://vibemon.io/install/install.py | python3 - --claude
```

Choose the flag matching the tool:

| Flag | Integration |
| --- | --- |
| `--claude` | Claude Code hooks and status line |
| `--codex` | Codex hooks and status-line configuration |
| `--kiro` | Kiro global hooks |
| `--openclaw` | OpenClaw plugin; macOS/Linux only |
| `--opencode` | OpenCode plugin and Python adapter |
| `--all` | Every detected tool |
| `--vibemon` | Shared scripts and configuration only |

Omit the flag for the interactive menu. A platform flag runs unattended and preserves existing user settings such as a custom Claude status line. Add `--yes` only to approve their replacement. VibeMon-owned scripts are upgraded in either mode.

On Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://vibemon.io/install/install.ps1))) --claude
```

The wrapper locates Python 3, downloads `install.py`, and requires its published SHA-256 before executing it. Use this wrapper instead of piping Python source through Windows PowerShell's text encoding. Install Python from python.org if no usable interpreter is found.

All remote scripts and configuration templates require a matching [manifest.json](manifest.json). Missing or mismatched references stop installation. Retry after the publisher deploys matching files; do not bypass verification.

The installer backs up modified configuration to `.bak`, writes atomically, and preserves unrelated hooks. Exit code `0` means every attempted installation succeeded. Undetected tools are skipped; a failure or a run with no installed tool returns `1`.

## 3. Configure delivery and account identity

Shared transmission settings are in `~/.vibemon/config.json`:

```json
{
  "debug": false,
  "cache_path": "~/.vibemon/cache/projects.json",
  "auto_launch": true,
  "http_urls": ["http://127.0.0.1:19280"],
  "serial_port": null,
  "vibemon_url": "https://vibemon.io",
  "vibemon_token": ""
}
```

Set `vibemon_token` to the generated write token. Cloud transport requires HTTPS. `http_urls` controls local targets separately. Restrict access to this file: installation uses mode `0600` on POSIX; Windows access must be restricted through the user's filesystem permissions.

Launch each monitored account with a stable `VIBEMON_ACCOUNT_ID` and a human-readable `VIBEMON_ACCOUNT_NAME`. Set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to the corresponding logged-in profile. These values must reach both the tool process and any App process refreshing that profile's usage. Two profiles with the same project label remain separate sources.

Use [Connect coding account](https://vibemon.io/coding-accounts/new) to generate settings for Codex, Claude, Kiro, OpenClaw, OpenCode, or another provider. Each provider can have several account IDs, such as `work` and `personal`. Provider-specific variables, including `VIBEMON_KIRO_ACCOUNT_ID` / `VIBEMON_KIRO_ACCOUNT_NAME`, override the common variables. Launch each agent in its matching signed-in environment; these labels do not switch provider logins. The first report connects the account. Unsupported usage stays unavailable.

The installer honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIRO_HOME`, and `OPENCODE_CONFIG_DIR`. OpenCode otherwise uses `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. Re-run installation after moving a profile or Python interpreter so generated commands match the new paths.

The shared directory contains six required helpers: `vibemon_core.py`, `usage.py`, `usage_cache.py`, `account_context.py`, `cache_io.py`, and `http_client.py`. Use `--vibemon` to repair them together. Installing only one helper can leave imports unresolved.

## 4. Activate and verify

1. Restart the coding tool. In Codex, open `/hooks` and review/trust the installed definitions. An explicit `[features].hooks = false` remains unchanged.
2. For OpenClaw, refresh its plugin registry if installation could not do so, then restart the gateway:

   ```sh
   openclaw plugins registry --refresh
   openclaw gateway restart
   ```

3. Start a coding session. The local App should show its project and state.
4. Open the App's **Monitoring** window, enter the Web origin and read token, and select the desired resources or accounts.
5. Confirm that the same account's source appears. Missing measurements remain unavailable; they do not appear as zero.

Read and write tokens must belong to the same Google owner. Resource collection is separate from hooks; see the [collector guide](https://vibemon.io/docs/collector) and [monitoring API](https://vibemon.io/docs/api/monitoring).

## Custom resources

Open [Custom resource](https://vibemon.io/resources/new) to define any resource type and up to 32 numeric measurements. Choose each metric's label, unit, and number or gauge display. Download the definition and use it in your collector. Its first authenticated observation registers the resource; generating the definition alone does not connect a source.

Send measurements with `kind: "resource"` to `/api/v1/ingest` using a write token. Web and App display the supplied definitions and status message. Use null for unavailable measurements. See the [custom-resource contract](https://vibemon.io/docs/api/monitoring#custom-resources) for JSON, limits, and history rules.

On the dashboard, **Edit metrics** changes existing resource labels, units, display ranges, and order, including Spark and Kubernetes presets. Reorder with the handles, arrow buttons, or Alt+Up/Down on a handle, then save. Both clients use the saved order; later collection does not overwrite it. New keys or units remain unavailable until the collector supplies matching definitions. Display-only edits do not change receipt time or erase retained measurements.

## Repair or uninstall

| Symptom | Action |
| --- | --- |
| Local status is missing | Confirm the App is running and `http_urls` includes its loopback endpoint. Reinstall the selected tool's hooks. |
| Cloud returns 401/403 | Replace a revoked token or use the correct read/write scope. |
| Import error in a hook | Reinstall all shared helpers with `--vibemon`. |
| Windows opens Microsoft Store | Disable Python App execution aliases or install a working Python interpreter. |
| Hooks fail after Python/profile changes | Re-run the installer to regenerate absolute paths. |
| Unknown usage | Confirm the selected tool profile is logged in. Unsupported or failed collection remains unavailable. |

Remove only VibeMon integration for a selected tool:

```sh
curl -fsSL https://vibemon.io/install/install.py | python3 - --uninstall --claude
```

The Windows wrapper accepts the same flags. `--uninstall --all` removes tool integrations; `--uninstall --vibemon` removes shared scripts. Configuration and unrelated hooks remain. A removal failure returns a failing exit code.

For hook event mappings and configuration details, see the [hook reference](https://vibemon.io/docs/hooks). ESP32 firmware and deployment are outside this overhaul; existing local serial integration is retained.
