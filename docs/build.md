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

macOS packages include the widget extension from `native/macos`, so a macOS build requires Xcode 16 or later. The `beforePack` hook builds it; see [macOS widgets](widgets.md#develop).

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

The native verification workflow runs lint, unit tests, the workspace, overlays, and unpacked packaging on both macOS and Windows. These checks use the pinned pnpm version and frozen lockfile. Signing/notarization and publication require their existing platform secrets; the verification workflows do not exercise them.

Every pull request runs `pull-request.yml`: lint, Jest with coverage thresholds, design tests, and registry and distribution checks on Linux, plus the hook and collector tests on Linux, Windows, and macOS. The macOS job also runs the real-process widget worker smoke test. The full verification runs before a release. `build-release.yml` first calls the public-distribution and native verification workflows on the tagged commit, and the platform builds start only after both pass. Pushes do not start CI; run either release workflow by hand (`gh workflow run registry-drift.yml --ref <branch>`, `gh workflow run overlay-verification.yml --ref <branch>`) when a branch needs a hosted check. Before merging, run the matching local checks.

Windows release builds require `WINDOWS_CERTS` (base64 PKCS#12) and `WINDOWS_CERTS_PASSWORD`. Signing is mandatory. CI compares each EXE with the configured signer, then verifies Authenticode file integrity, the exact leaf certificate, and the timestamp with `osslsigncode`. The configured certificate is an explicit trust anchor for this check; the runner and end-user OS trust stores are not modified. A modified-file check must fail before publication.

The current OpsPresso Windows certificate is self-signed. Windows may show an unknown-publisher warning. The App keeps Windows update signature verification enabled, so automatic installation requires Windows to trust the publisher; use manual downloads where it does not. This release check does not claim public-CA trust.

macOS releases require code-signature, notarization ticket, and Gatekeeper verification. Every release builds the commit referenced by its tag and requires the tag to match `package.json`. Both platform builds and signature checks must pass before GitHub publication. Windows blockmaps are published with the installers; failed Homebrew dispatches fail the workflow.

The macOS main executable declares Apple Events access for terminal focus. Renderer and GPU helpers use separate entitlements without that access. The package includes the permission explanation in English, Korean, and Japanese. Package verification checks the signed main/helper permissions and the bundled explanations; user consent remains controlled by macOS.

## Cloud connection checks

Each App build packages `public/install/manifest.json`. Unattended hook updates run only while Web serves a byte-identical `/install/manifest.json`, so release the App from the same App commit that Web pins in `app-assets.json`. Until both match, hook updates need **Reinstall** in Settings. See [hook installation and updates](features.md#hook-installation-and-updates).

Publish Web with `GET /api/v1/connection?scope=write` before distributing an App that uses **Save and verify** for hook delivery. Older Web servers return an explicit upgrade message; the App does not write a synthetic observation to probe permissions. Existing hook delivery continues independently of this setup check.
