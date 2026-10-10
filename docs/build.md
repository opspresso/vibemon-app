# Build and release

Use Node.js 26.11.1 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm exec jest --coverage --runInBand
pnpm build:mac
```

Build scripts pass `--publish never`. For unsigned local macOS verification, set `CSC_IDENTITY_AUTO_DISCOVERY=false`. A successful unsigned build verifies packaging; it does not verify signing or notarization.

Desktop packages bundle Electron, so it belongs in development dependencies. Releases are distributed through GitHub and Homebrew. The root package is private and cannot be published to npm. `dist/` contains generated build artifacts and is not committed.

Desktop packaging uses an explicit allowlist: `src/`, application icons, `LICENSE`, and package metadata, plus production dependencies assembled by electron-builder. Development configuration, environment files, tests, coverage, and maintenance scripts are excluded. With the same Electron 43.7.9 dependency lock, this reduced the application ASAR from 8,708,272 to 5,979,179 bytes during verification. This is a package-size comparison, not a startup-time benchmark.

## Public distribution

This public App repository owns hooks, collectors, registries, character art, resource schema, and shared renderers. `web-distribution.json` lists the exact files Web may consume. App validation and releases require no private Web checkout or read credential.

```sh
pnpm check:registry
pnpm check:distribution
pnpm build:distribution
```

`dist/web/` contains the public `/install` and `/static` payload plus SHA-256 checksums. It excludes the Desktop application, development files, and credentials. The public-distribution workflow validates the export and uploads it as an artifact; Web consumes a pinned App commit, not a moving artifact URL.

Edit the canonical App source, update the export map when adding files, and regenerate the installer manifest with `python3 scripts/generate_manifest.py` when changing an installer file. Commit and push App first. In the private Web checkout, advance `app-assets.json` with `node scripts/sync-app-assets.mjs --revision <full-App-commit> --fix`, then run `pnpm check:assets`. Local verification may use `VIBEMON_APP_DIR=../vibemon-app`; CI reads the same public commit without authentication. See [distribution ownership](distribution.md).

Native build and overlay workflows use the pinned pnpm version and frozen lockfile. Signing/notarization and publication require their existing platform secrets; local validation does not exercise them.

Windows release builds require `WINDOWS_CERTS` and `WINDOWS_CERTS_PASSWORD` for a code-signing certificate trusted by Windows. CI requires signing and checks every generated EXE with `Get-AuthenticodeSignature` before publishing artifacts. The publisher name is derived from the signing certificate and the updater retains its platform signature verification. A self-signed or missing certificate must be replaced for a production release; integrity hashes do not replace publisher verification. Unsigned local packages are for development verification only.
