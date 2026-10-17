# VibeMon setup

Install hooks to send coding-agent summaries to the local Desktop App, the Web service, or both, and install collectors for Linux hosts, DGX Spark, and Kubernetes. Python 3 is required. Web uses Google or invited email sign-in; agent-provider credentials remain on the machine running the hooks.

Desktop auto-launch opens the installed macOS App or a Windows installer location (or `VibeMon.exe` on PATH). Start custom Windows installations and other platforms manually. Hooks never install or run an npm package.

## 1. Sign in

The installer signs in through Web, so you do not copy tokens:

1. The installer shows a code, such as `BCDF-GHJK`, and the address `https://vibemon.io/device`. In a desktop terminal it also opens that page.
2. Sign in with Google or an invited email account, check the code, and select **Allow**.
3. The installer receives a write token named after the client and this host, such as `Coding agent hooks (build-box)`, and saves it.

A run in a terminal signs in when no token is saved. Add `--login` to sign in again, for example to replace a deleted token or to move to another Web origin. Runs without a terminal, such as App updates, never wait for a sign-in: without a token, activity stays local.

For automation, supply a generated write token through `VIBEMON_WRITE_TOKEN` from your environment or secret manager instead. Create it on [Account](https://vibemon.io/account). Do not put tokens in URLs or shell history.

Account lists every token. Delete a token there to disconnect its client; deletion immediately stops its API access without removing resource data.

## 2. Install hooks

Desktop users can open **Settings → Integrations** and choose **Install integration** for a detected tool. Open **Send activity to Web**, enter the Web origin and a separate write token, and select **Save and verify**. The dashboard read token remains in **Settings → Connections**. These are shared hook defaults; per-agent environment variables and plugin settings retain their precedence.

For a headless macOS or Linux installation:

```sh
curl -fsSL https://vibemon.io/install/install.py | python3 - --claude
```

Choose the flag matching the tool:

| Flag | Integration |
| --- | --- |
| `--claude` | Claude Code hooks and status line |
| `--codex` | Codex hooks; `~/.codex/config.toml` is not changed |
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

Windows hooks keep the interpreter that ran the installer. Codex and Kiro may use different command shells. Plain paths run directly; paths with spaces or shell characters use Windows PowerShell's [UTF-16LE `EncodedCommand`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1) to preserve literal executable and script arguments. Standard input and failure results still reach the provider. The App inspects these arguments without executing them, so a moved interpreter remains **Needs repair**. Reinstall after moving Python or a tool's configuration directory.

All remote scripts and configuration templates require a matching [manifest.json](manifest.json). Missing or mismatched references stop installation. Retry after the publisher deploys matching files; do not bypass verification.

The installer backs up modified configuration to `.bak`, writes atomically, and preserves unrelated hooks. Exit code `0` means every attempted installation succeeded. Undetected tools are skipped; a failure or a run with no installed tool returns `1`.

## Self-hosted installation

`VIBEMON_DOCS_URL` selects the installer file base, including its manifest and every helper/template. `VIBEMON_URL` selects the Web API origin and is saved in hook configuration when supplied. The two can use different hosts, for example when installation files are served by a CDN.

```sh
export VIBEMON_DOCS_URL=https://monitor.example/install
export VIBEMON_URL=https://monitor.example
curl -fsSL "$VIBEMON_DOCS_URL/install.py" | python3 - --codex --login
```

PowerShell uses the same environment variables; download `install.ps1` from the chosen file base. The Python installer and PowerShell wrapper reject redirects, credentials in URLs, query strings, and fragments. Python file downloads are limited to 1 MiB. HTTPS certificate verification stays enabled. For isolated loopback development only, `VIBEMON_ALLOW_HTTP_LOCAL=1` permits HTTP on localhost addresses.

Changing the API origin while a write token is saved requires `--login` or an explicitly supplied `VIBEMON_WRITE_TOKEN`. The installer never moves a saved credential to a new host automatically. Without these overrides, the existing API configuration is preserved and installation files come from `https://vibemon.io/install`.

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

Upgrades reject saved legacy tokens that do not use the server-generated format. Supply `VIBEMON_WRITE_TOKEN` or enter a replacement at the hidden prompt. Format validation does not check revocation or permissions. Hooks report Web delivery failures on stderr even with `debug: false`: HTTP 401 requires an active token, and HTTP 403 requires write permission. Local delivery can succeed while Web delivery fails; verify a recent receipt in the Web dashboard after a real hook event.

Launch each monitored account with a stable `VIBEMON_ACCOUNT_ID` and a human-readable `VIBEMON_ACCOUNT_NAME`. Set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to the corresponding logged-in profile. These values must reach both the tool process and any App process refreshing that profile's usage. Two profiles with the same project label remain separate sources.

Use [Connect coding account](https://vibemon.io/coding-accounts/new) to generate settings for Codex, Claude, Kiro, OpenClaw, OpenCode, or another provider. Each provider can have several account IDs, such as `work` and `personal`. Provider-specific variables, including `VIBEMON_KIRO_ACCOUNT_ID` / `VIBEMON_KIRO_ACCOUNT_NAME`, override the common variables. Launch each agent in its matching signed-in environment; these labels do not switch provider logins. The first report connects the account. Unsupported usage stays unavailable.

The installer honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIRO_HOME`, and `OPENCODE_CONFIG_DIR`. OpenCode otherwise uses `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. Re-run installation after moving a profile or Python interpreter so generated commands match the new paths.

The shared directory contains eight required helpers: `vibemon_core.py`, `session_activity.py`, `project_context.py`, `usage.py`, `usage_cache.py`, `account_context.py`, `cache_io.py`, and `http_client.py`. Use `--vibemon` to repair them together. Installing only one helper can leave imports unresolved.

## 4. Activate and verify

1. Restart the coding tool. In Codex, open `/hooks` and review/trust the installed definitions. An explicit `[features].hooks = false` remains unchanged.
2. For OpenClaw, refresh its plugin registry if installation could not do so, then restart the gateway:

   ```sh
   openclaw plugins registry --refresh
   openclaw gateway restart
   ```

3. Start a coding session. The local App should show its project and state.
4. Open **Settings → Connections** in the App, enter the Web origin and read token, and select **Save and connect**. Use **Customize view** to select resources, accounts, and metrics.
5. Confirm that the same account's source appears. Missing measurements remain unavailable; they do not appear as zero.

Read and write tokens must belong to the same Google owner. Resource collection is separate from hooks; see [Monitor servers and clusters](https://vibemon.io/docs/servers) and [Send your own data](https://vibemon.io/docs/api).

## Resource collectors

A collector sends CPU, memory, GPU, and disk summaries of a server or cluster. It signs in through Web the same way.

| Target | Command |
| --- | --- |
| Linux host or DGX Spark | `curl -fsSL https://vibemon.io/install/install.py \| python3 - --collector` |
| Kubernetes (current kubectl context) | `curl -fsSL https://vibemon.io/install/install.py \| python3 - --kubernetes` |

A run with a saved token reuses it only for the same Web origin; another origin, or `--login`, signs in again. Add `--name "Display name"` to choose the name on Web. The default is the host name or the kubectl context name. The source ID derives from it, such as `host-dgx-spark`.

**Linux host or DGX Spark** needs Python 3.10 or later and systemd. The installer downloads the collector files checked against the manifest, installs `psutil` in its own Python environment, and starts the `vibemon-collector` service. DGX Spark unified memory and NVIDIA GPU measurements are detected automatically.

- As root: the service is system-wide. Files are in `/opt/vibemon-collector`, and the token is in `/etc/vibemon/collector.env` (mode 600).
- As another user: the service is a user service, with files in `~/.local/share/vibemon-collector` and the token in `~/.config/vibemon/collector.env`. Run `sudo loginctl enable-linger $USER` so that it keeps running after you log out.
- Check it with `systemctl status vibemon-collector` (add `--user` for a user service).

**Kubernetes** needs `kubectl` with the target cluster as the current context. The installer creates the `vibemon` namespace, read-only RBAC (list nodes and pods, read node metrics), a Secret with the token, and a Deployment of the published multi-arch collector image. CPU and memory need [metrics-server](https://github.com/kubernetes-sigs/metrics-server); without it, node and pod counts still work. The installer waits until Web accepts the first summary and otherwise shows the collector's last message.

To remove a collector, run the same command with `--uninstall`. On Kubernetes, it removes only objects that the installer labeled; it refuses an existing `vibemon` namespace that the installer did not create. The token stays valid until you delete it on Account. For Prometheus-based clusters and other options, see the [collector guide](https://github.com/opspresso/vibemon-app/tree/main/collector).

## Custom resources

Open [Custom resource](https://vibemon.io/resources/new) to define any resource type and up to 32 numeric measurements. Choose each metric's label, unit, and number or gauge display. Download the definition and use it in your collector. Its first authenticated observation registers the resource; generating the definition alone does not connect a source.

Send measurements with `kind: "resource"` to `/api/v1/ingest` using a write token. Web and App display the supplied definitions and status message. Use null for unavailable measurements. See [Send a resource](https://vibemon.io/docs/api#send-a-resource) for JSON and limits.

On the Web dashboard, open resource **Details → Edit resource and metrics** to change labels, units, display ranges, and order, including Spark and Kubernetes presets. In Desktop, open **Details → Edit resource on Web** to reach the editor. Reorder with the handles, arrow buttons, or Alt+Up/Down on a handle, then select **Save changes**. Both clients use the saved order; later collection does not overwrite it. New keys or units remain unavailable until the collector supplies matching definitions. Display-only edits do not change receipt time or erase retained measurements.

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

For hook event mappings and configuration details, see the [hook reference](https://github.com/opspresso/vibemon-app/blob/main/docs/hooks.md).

## VibeMon Touch and legacy devices

VibeMon Touch on the four-inch ESP32-S3 board reads summaries from Web over HTTPS. Configure Wi-Fi, the Web origin, and a read token on the device. Hooks deliver to Web with a write token; neither `http_urls` nor `serial_port` configures Touch. See the [Touch setup guide](https://github.com/opspresso/vibemon-esp32#set-up-the-device).

Local HTTP/serial delivery remains available for ESP32-C6 devices using the [previous firmware](https://github.com/opspresso/vibemon-esp32/tree/e6c272c). The Touch firmware is not compatible with C6 boards.
