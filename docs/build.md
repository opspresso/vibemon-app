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
