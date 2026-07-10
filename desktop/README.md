# VibeMon

[![npm version](https://img.shields.io/npm/v/vibemon.svg)](https://www.npmjs.com/package/vibemon)
[![npm downloads](https://img.shields.io/npm/dm/vibemon.svg)](https://www.npmjs.com/package/vibemon)
[![license](https://img.shields.io/npm/l/vibemon.svg)](https://github.com/opspresso/vibemon-app/blob/main/LICENSE)

**Real-time status monitor for AI assistants with pixel art character display.**

See at a glance what your AI assistant is doing — thinking, working, or waiting for input. A cute pixel art character visually represents the current state.

![Demo](https://raw.githubusercontent.com/opspresso/vibemon-app/main/images/demo.gif)

## Quick Start

```bash
npx vibemon
```

Or via Homebrew:

```bash
brew tap opspresso/tap
brew install opspresso/tap/vibemon
```

The app launches in the system tray and listens on `http://127.0.0.1:19280`.

## Supported Tools

- **[Claude Code](https://claude.ai/code)** - Anthropic's AI coding assistant
- **[Codex](https://openai.com/codex)** - OpenAI's AI coding agent
- **[Kiro](https://kiro.dev/)** - AWS's AI coding assistant
- **[OpenClaw](https://openclaw.ai/)** - Open-source computer use agent

## Integration Notes

- **Claude Code** and **Kiro** are the cleanest real-time integrations because they expose direct hook events around prompts, tool use, and turn completion.
- **Codex** is supported, but its interactive hook surface is currently narrower than Claude Code. For automation, `codex exec --json` provides richer telemetry.
- **OpenClaw** support is plugin-based. VibeMon uses a bridge plugin because OpenClaw's simpler internal hooks are not designed around the same tool loop.

## Features

- **Frameless Window** - Clean floating design
- **Always on Top** - Always displayed above other windows
- **System Tray** - Quick control from the menu bar
- **Multi-window** - One window per project (up to 5)
- **Snap to Corner** - Auto-snaps near screen edges
- **Click to Focus** - Switch to iTerm2/Ghostty tab (macOS)
- **Open at Login** - Auto-start on macOS login
- **HTTP API** - Easy integration with hooks

## Documentation

For full documentation, visit **[vibemon.io/docs](https://vibemon.io/docs)**.

## Links

- [Homepage](https://opspresso.github.io/vibemon-app/)
- [GitHub Repository](https://github.com/opspresso/vibemon-app)

## License

MIT
