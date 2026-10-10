# Build and release

Use Node.js 26.11.1 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm exec jest --coverage --runInBand
pnpm test:workspace
pnpm test:overlays
pnpm build:mac
```

Build scripts pass `--publish never`. For unsigned local macOS verification, set `CSC_IDENTITY_AUTO_DISCOVERY=false`. A successful unsigned build verifies packaging; it does not verify signing or notarization.

Desktop packages bundle Electron, so it belongs in development dependencies. Releases are distributed through GitHub and Homebrew. The root package is private and cannot be published to npm. `dist/` contains generated build artifacts and is not committed.

Desktop packaging uses an explicit allowlist: `src/`, application icons, `LICENSE`, and package metadata, plus production dependencies assembled by electron-builder. Development configuration, environment files, tests, coverage, and maintenance scripts are excluded.

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

Windows release builds require `WINDOWS_CERTS` (base64 PKCS#12) and `WINDOWS_CERTS_PASSWORD`. Signing is mandatory. CI compares each EXE with the configured signer, then verifies Authenticode file integrity, the exact leaf certificate, and the timestamp with `osslsigncode`. The configured certificate is an explicit trust anchor for this check; the runner and end-user OS trust stores are not modified. A modified-file check must fail before publication.

The current OpsPresso Windows certificate is self-signed. Windows may show an unknown-publisher warning. The App keeps Windows update signature verification enabled, so automatic installation requires Windows to trust the publisher; use manual downloads where it does not. This release check does not claim public-CA trust.

macOS releases require code-signature, notarization ticket, and Gatekeeper verification. Every release builds the commit referenced by its tag and requires the tag to match `package.json`. Both platform builds and signature checks must pass before GitHub publication. Windows blockmaps are published with the installers; failed Homebrew dispatches fail the workflow.
