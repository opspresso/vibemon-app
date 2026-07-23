# Repository Guidelines

## Project Structure & Module Organization

VibeMon is an Electron desktop application. The main process starts in `src/main.js`; CommonJS services live in `src/modules/`, shared registries in `src/shared/`, and renderer code in `src/renderer.js`, `src/bubble/`, and `src/engine/`. Keep tests in `tests/`, documentation in `docs/`, CLI code in `bin/`, character art in `src/assets/characters/`, and application icons in `assets/`.

## Architecture & Data Flow

HTTP and WebSocket updates converge at `routeStatusUpdate()` and flow through `CharacterWindowManager` to one retargetable character window and speech bubble. Preserve this ingress and focus-selection behavior. State and character registries are canonical in `vibemon-static`; update them there, then sync fallbacks with `pnpm check:registry -- --fix`. Keep timeouts and sizes in `src/shared/data/constants.json` (`_MS` for milliseconds). The renderer CSP requires local Three.js files; do not use runtime CDN imports.

## Build, Test, and Development Commands

Use pnpm:

- `pnpm install` installs dependencies.
- `pnpm start` launches the Electron app locally.
- `pnpm lint` checks JavaScript and CommonJS files with ESLint.
- `pnpm test` runs the Jest suite once; `pnpm test:watch` reruns affected tests during development.
- `pnpm test:coverage` writes coverage reports to `coverage/`.
- `pnpm build` creates platform packages without publishing. Use `pnpm build:mac`, `pnpm build:win`, or `pnpm build:linux` for a specific target.
- `pnpm check:registry` validates shared registry data.

## Coding Style & Naming Conventions

Follow `eslint.config.js`: two-space indentation, single quotes, semicolons, no trailing commas, and an ending newline. Use `camelCase` for variables and functions, `PascalCase` for classes, and kebab-case filenames such as `state-manager.cjs`. Preserve module boundaries: main-process modules use CommonJS (`.cjs`), while renderer and engine code may use ES modules. Do not edit files under `src/vendor/`.

## Testing Guidelines

Jest runs in the Node environment and discovers `tests/**/*.test.js`. Name tests after the source unit, for example `tests/validators.test.js`, and group behavior with `describe` and focused `test` cases. Add regression coverage for behavior changes. Global branch, function, line, and statement coverage must each remain at or above 60%.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat:`, `fix:`, and `chore:` with short imperative summaries. Keep commits focused. Pull requests should explain the effect, list validation commands, link issues, and include screenshots or recordings for visual changes. Never commit generated `coverage/` or `dist/` output.

## Security & Configuration

Do not commit API keys, tokens, local environment files, or machine-specific hook settings. Keep the HTTP service bound to its intended local interface unless a reviewed change explicitly requires broader exposure.
