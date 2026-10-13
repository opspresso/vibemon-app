# Repository Guidelines

## Project Structure & Module Organization

VibeMon is an Electron desktop application. The main process starts in `src/main.js`; CommonJS services live in `src/modules/`, shared registries in `src/shared/`, and renderer code in `src/renderer.js`, `src/shared/bubble/`, and `src/engine/`. Keep tests in `tests/`, documentation in `docs/`, character art in `src/assets/characters/`, and application icons in `assets/`.

## Architecture & Data Flow

Local HTTP and scoped cloud polling updates converge at `routeStatusUpdate()` and flow through `CharacterWindowManager` to one retargetable character window and speech bubble. Preserve this ingress and focus-selection behavior. This public repository owns the state/character registries, character art, shared rendering modules, hooks, and Python collector. `web-distribution.json` maps their source paths to the public files consumed by private Web. Keep timeouts and sizes in `src/shared/data/constants.json` (`_MS` for milliseconds). The renderer CSP requires local Three.js files; do not use runtime CDN imports — `src/renderer.js` passes the vendored three.js namespace to the 3D engine as `options.THREE`.

## Build, Test, and Development Commands

Use Node.js 26.11.1 from `.nvmrc` and pnpm:

- `pnpm install` installs dependencies.
- `pnpm start` launches the Electron app locally.
- `pnpm lint` checks JavaScript and CommonJS files with ESLint.
- `pnpm test` runs the Jest suite once; `pnpm test:watch` reruns affected tests during development.
- `pnpm test:coverage` writes coverage reports to `coverage/`.
- `pnpm build` creates platform packages without publishing. Use `pnpm build:mac`, `pnpm build:win`, or `pnpm build:linux` for a specific target.
- `pnpm check:registry` validates local registry fields, image references, and dimensions.
- `pnpm check:distribution` validates the public export map without network or private credentials.
- `pnpm build:distribution` writes the reviewed installer/static payload to `dist/web/`.
- `python3 -m pytest tests/hooks collector/tests` checks hooks and collector behavior (install pytest and `./collector` in a virtual environment first).

## Coding Style & Naming Conventions

Follow `eslint.config.js`: two-space indentation, single quotes, semicolons, no trailing commas, and an ending newline. Use `camelCase` for variables and functions, `PascalCase` for classes, and kebab-case filenames such as `state-manager.cjs`. Preserve module boundaries: main-process modules use CommonJS (`.cjs`), while renderer and engine code may use ES modules. Do not edit files under `src/vendor/`. `src/shared/design/` owns the shared App/Web visual tokens and brand mark. Export changes through `web-distribution.json`; do not maintain a second palette in Web. `src/shared/resource-schema.cjs`, `src/engine/`, `src/shared/bubble/`, `src/shared/data/{states,characters}.json`, and `src/assets/characters/` are canonical here. Installer sources live in `public/install/`, their tests in `tests/hooks/`, and sprite authoring tools in `tools/sprites/`. Regenerate `public/install/manifest.json` with `python3 scripts/generate_manifest.py` when an installer payload changes.

## Testing Guidelines

Jest runs in the Node environment and discovers `tests/**/*.test.js`. Name tests after the source unit, for example `tests/validators.test.js`, and group behavior with `describe` and focused `test` cases. Add regression coverage for behavior changes. Global branch, function, line, and statement coverage must each remain at or above 60%.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat:`, `fix:`, and `chore:` with short imperative summaries. Keep commits focused. Pull requests should explain the effect, list validation commands, link issues, and include screenshots or recordings for visual changes. Never commit generated `coverage/` or `dist/` output.

## Security & Configuration

Do not commit API keys, tokens, local environment files, or machine-specific hook settings. Keep the HTTP service bound to its intended local interface unless a reviewed change explicitly requires broader exposure.
