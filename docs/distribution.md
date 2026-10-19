# Public distribution ownership

The public `vibemon-app` repository owns hooks, collectors, the Desktop App, and shared rendering contracts. Private `vibemon-web` owns authentication, ingestion, storage, the dashboard, and the documentation site. This guide describes their public file distribution.

[VibeMon Touch](https://github.com/opspresso/vibemon-esp32) has its own firmware repository. It pins App-owned monitoring rules and design tokens, and reads summaries from Web over HTTPS.

| Content | Source in App | Web destination |
| --- | --- | --- |
| Hook installer, adapters, templates, manifest | `public/install/` | `/install/*` |
| State and character registries | `src/shared/data/` | `/static/data/*` |
| Product design tokens and mark | `src/shared/design/` | `/static/design/*` |
| Character images | `src/assets/characters/` | `/static/characters/*` |
| Shared renderers and resource schema | `src/engine/`, `src/shared/bubble/`, `src/shared/resource-schema.*` | `/static/js/*`, `/static/css/*` |
| Hook and collector guides | `docs/hooks.md`, `collector/README.md` | `/docs/hooks`, `/docs/collector` |
| Python resource collector | `collector/` | Install from this public repository |
| Sprite authoring tools and references | `tools/sprites/` | Not included in runtime packages |

Shared guides are rendered in both repositories. Use relative links only for other exported paths; use absolute public App URLs for repository-only references.

`web-distribution.json` is the export allowlist. It excludes private configuration, application preferences, credentials, and authoring artifacts. Static files are exported directly from their runtime source paths, so App does not maintain a second renderer or character copy.

The collector owns `collector/vibemon_collector/http_deadline.py`. The same source is exported into the collector package and `/install/vibemon/http_deadline.py`; hook installs place it beside `http_client.py`. Both paths are verified by the installer manifest. Local checkout installs resolve the hook path to the canonical collector source.

## Validate and export

```sh
pnpm check:registry
pnpm check:distribution
pnpm build:distribution
```

The export writes only `dist/web/`. The public-distribution CI runs before each release and by hand. It checks installer integrity and hook/collector behavior on Linux and Windows, validates Prometheus queries, and uploads the generated payload. It does not need a Web token or checkout.

Web's `app-assets.json` pins a full App commit. Its sync command fetches that public revision, validates the source/destination paths, compares every byte, and preserves unrelated files. A network or content mismatch fails the check; a stale bundled snapshot is not silently accepted. Web deploys the already-verified files without fetching at request time.

## Install without private repository access

- [Hook setup](../public/install/setup.md) uses the public installer URL. A local checkout also supports `python3 public/install/install.py`.
- [Collector setup](../collector/README.md) installs the Python package from this repository.
- Desktop source builds use this repository alone. Cloud monitoring still needs a reachable Web service and an account's read token.

The old Docs and Static repositories are retired. Their Pages and Actions are disabled. `docs.vibemon.io`, `static.vibemon.io`, and `static.vibemon.toast.sh` now serve the pinned files from Web on AWS Amplify. Canonical and legacy HTTPS paths must return identical bytes; no private Web credential is required to download this public content.
