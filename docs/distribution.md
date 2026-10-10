# Public distribution ownership

VibeMon is maintained in two repositories: public `vibemon-app` and private `vibemon-web`. App owns everything needed to install hooks, collect measurements, build the Desktop App, and render shared characters. Web owns authentication, ingestion, storage, the dashboard, and the documentation site.

| Content | Source in App | Web destination |
| --- | --- | --- |
| Hook installer, adapters, templates, manifest | `public/install/` | `/install/*` |
| State and character registries | `src/shared/data/` | `/static/data/*` |
| Character images | `src/assets/characters/` | `/static/characters/*` |
| Shared renderers and resource schema | `src/engine/`, `src/bubble/`, `src/shared/resource-schema.*` | `/static/js/*`, `/static/css/*` |
| Hook and collector guides | `docs/hooks.md`, `collector/README.md` | `/docs/hooks`, `/docs/collector` |
| Python resource collector | `collector/` | Install from this public repository |
| Sprite authoring tools and references | `tools/sprites/` | Not included in runtime packages |

Shared guides are rendered in both repositories. Use relative links only for other exported paths; use absolute public App URLs for repository-only references.

`web-distribution.json` is the export allowlist. It excludes private configuration, application preferences, credentials, and authoring artifacts. Static files are exported directly from their runtime source paths, so App does not maintain a second renderer or character copy.

## Validate and export

```sh
pnpm check:registry
pnpm check:distribution
pnpm build:distribution
```

The export writes only `dist/web/`. The public-distribution CI checks installer integrity and hook/collector behavior on Linux and Windows, validates Prometheus queries, and uploads the generated payload. It does not need a Web token or checkout.

Web's `app-assets.json` pins a full App commit. Its sync command fetches that public revision, validates the source/destination paths, compares every byte, and preserves unrelated files. A network or content mismatch fails the check; a stale bundled snapshot is not silently accepted. Web deploys the already-verified files without fetching at request time.

## Install without private repository access

- [Hook setup](../public/install/setup.md) uses the public installer URL. A local checkout also supports `python3 public/install/install.py`.
- [Collector setup](../collector/README.md) installs the Python package from this repository.
- Desktop source builds use this repository alone. Cloud monitoring still needs a reachable Web service and an account's read token.

The old Docs and Static repositories are retired. Their Pages and Actions are disabled. `docs.vibemon.io`, `static.vibemon.io`, and `static.vibemon.toast.sh` now serve the pinned files from Web on AWS Amplify. Canonical and legacy HTTPS paths must return identical bytes; no private Web credential is required to download this public content.
