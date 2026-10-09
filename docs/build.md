# Build and npm packaging

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm exec jest --coverage --runInBand
pnpm build:mac
```

Build scripts pass `--publish never`. For unsigned local macOS verification, set `CSC_IDENTITY_AUTO_DISCOVERY=false`. A successful unsigned build verifies packaging; it does not verify signing or notarization.

Desktop packages bundle Electron, so it belongs in development dependencies. The npm launcher needs Electron installed alongside the JavaScript app. `pnpm prepare:npm` creates a separate `dist/npm` package whose production dependencies include the same Electron version range. The npm publication workflow publishes from that directory after validation. Do not publish the root development manifest directly.

`dist/` contains generated artifacts and is not committed. `prepare:npm` replaces only its own `dist/npm` staging directory; it does not remove desktop build output.

Desktop packaging uses an explicit allowlist: `src/`, application icons, `LICENSE`, and package metadata, plus production dependencies assembled by electron-builder. Development configuration, environment files, tests, coverage, and maintenance scripts are excluded. With the same Electron 43.7.9 dependency lock, this reduced the application ASAR from 8,708,272 to 5,979,179 bytes during verification. This is a package-size comparison, not a startup-time benchmark.

## Canonical assets and CI access

`web-assets.json` pins the Web source commit. Verify that exact revision locally:

```sh
VIBEMON_WEB_DIR=../vibemon-web pnpm check:registry
```

The checkout must contain the pinned commit; its working-tree files are not used. Advance `web-assets.json` to a committed Web revision and run the same command with `-- --fix` when updating assets.

Web is private. For remote checks, set `VIBEMON_WEB_READ_TOKEN` to a credential with read-only `contents` access to `opspresso/vibemon-web`. Configure the same name as an App repository Actions secret. Do not reuse or publish a developer's broad CLI token. The checker uses authenticated GitHub content requests, rejects redirects, and fails explicitly when access is missing.

Native build, npm publication, and overlay workflows use the pinned pnpm version and frozen lockfile. Signing/notarization and publication require their existing platform secrets; local validation does not exercise them.

Windows release builds require `WINDOWS_CERTS` and `WINDOWS_CERTS_PASSWORD` for a code-signing certificate trusted by Windows. CI requires signing and checks every generated EXE with `Get-AuthenticodeSignature` before publishing artifacts. The publisher name is derived from the signing certificate and the updater retains its platform signature verification. A self-signed or missing certificate must be replaced for a production release; integrity hashes do not replace publisher verification. Unsigned local packages are for development verification only.
