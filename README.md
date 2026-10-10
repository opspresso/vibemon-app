# VibeMon Desktop

[![Release](https://img.shields.io/github/v/release/opspresso/vibemon-app)](https://github.com/opspresso/vibemon-app/releases/latest)
[![License](https://img.shields.io/github/license/opspresso/vibemon-app)](LICENSE)

Monitor selected resources and coding accounts from your desktop. VibeMon combines cloud summaries with local coding-agent activity, a floating character, and a speech bubble.

- Monitor custom resources, servers, DGX Spark hosts, and Kubernetes clusters.
- Select multiple Codex, Claude, Kiro, or other provider accounts independently.
- Choose visible metrics and view recent-hour trends. Web edits to resource labels, ranges, and order appear on the next poll.
- Receive local tool events without a cloud connection. Hooks support Claude Code, Codex, Kiro, OpenClaw, and OpenCode.

![Desktop workspace with synthetic monitoring data](docs/images/workspace-overview-light.png)

## Install and start

On macOS:

```sh
brew install opspresso/tap/vibemon
```

For Windows or a direct macOS installer, download the matching package from [Releases](https://github.com/opspresso/vibemon-app/releases/latest). npm distribution is discontinued; existing npm packages do not receive updates.

Windows packages use the OpsPresso self-signed certificate. Windows may show an unknown-publisher warning, and automatic updates require a trusted publisher.

Open the installed VibeMon application. It starts in the system tray and listens locally on `http://127.0.0.1:19280`.

## Connect cloud sources

1. Sign in to [VibeMon Account](https://vibemon.io/account) with Google.
2. Create a **Read** token and select **Show token** to copy it. Tokens can be retrieved again; deleting one stops its API access.
3. Click the App tray icon and open **Settings → Connections**. Enter the Web origin and read token, then select **Save and connect**.
4. Open **Customize view**, select resources, provider accounts, and metrics, then select **Save view**.

A source appears after its collector or hook sends the first report. Follow the [connection guide](https://vibemon.io/docs) to set up separate write tokens, custom resources, or several accounts for one provider. Provider credentials remain on the source machine.

The App keeps its read token in OS secure storage. **Disconnect** removes the local credential; deleting the token on Web invalidates it for every client using it. See [the desktop workspace guide](docs/monitoring.md) for selection, missing data, stale sources, and troubleshooting.

## Connect local coding tools

Open **Settings → Integrations → Install integration** for the tool you use, then restart that tool. Local character updates do not require Google login. Sending the same activity to Web requires a separate write token in the hook configuration; the App's read token is never reused for hooks.

Tool detection honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIRO_HOME`, and `OPENCODE_CONFIG_DIR`. These variables must reach both the tool and App processes. OpenClaw installation is supported on macOS/Linux. See the [hook installation guide](https://vibemon.io/docs/setup) for headless/Windows setup and [hook reference](https://vibemon.io/docs/hooks) for event mappings.

## Character display

One character window follows the active local or selected cloud project. Drag the character or bubble to move them together; use **Settings → Companion → Character** to choose a fixed character. See [desktop features](docs/features.md) for states, characters, settings, and interaction details.

![VibeMon character preview](images/demo.gif)

## Develop

Use Node.js 26.11.1 (`nvm use`) and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm start
```

Web development normally runs on `http://localhost:3030`; the unpackaged App accepts that loopback origin. Packaged apps require HTTPS. Build and validation commands are in [build and packaging](docs/build.md).

## Documentation and related projects

- [Documentation index](docs/README.md) — Desktop user and developer guides.
- [Local HTTP API](docs/api.md) — Loopback status, window, and health endpoints.
- [Web Monitoring API](https://vibemon.io/docs/api/monitoring) — Cloud tokens, summaries, settings, and trends.
- [Web service](https://vibemon.io) — Login, source configuration, and browser dashboard.
- [Hooks and collector source](docs/distribution.md) — Public installers, collector, shared schema, registries, and rendering assets live in this repository.
- [Web source](https://github.com/opspresso/vibemon-web) — Private service implementation; App installation, builds, and CI do not require access.
- [ESP32 firmware](https://github.com/opspresso/vibemon-esp32) — Separate hardware project; its legacy cloud WebSocket transport is unavailable.

## License

MIT
