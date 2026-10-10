# Desktop documentation

## Use the App

- [Install and connect](../README.md#install-and-start) — Packages, cloud connection, and local hooks.
- [Desktop workspace](monitoring.md) — Dashboard, read tokens, resource/account selection, settings, and recovery.
- [Desktop features](features.md) — Character states, animations, settings, and tray controls.
- [Web connection guide](https://vibemon.io/docs) — Google login, tokens, collectors, and coding accounts.

## Integrate and develop

- [Local HTTP API](api.md) — The App's loopback endpoints on port 19280.
- [Web Monitoring API](https://vibemon.io/docs/api/monitoring) — Authenticated cloud endpoints; separate from the local API.
- [Hook installation](../public/install/setup.md) and [hook reference](hooks.md) — Canonical public integration source.
- [Resource collector](../collector/README.md) — Public host/Spark/Kubernetes collector.
- [Distribution ownership](distribution.md) — App source, pinned Web snapshots, and standalone validation.
- [Build and packaging](build.md) — Dependencies, validation, canonical assets, signing, and publication.
- [Overlay verification](overlay-interaction.md) — Character/bubble input, movement, and display scaling.
- [Pet proposal](milestone/vibemon-pet-development-spec.md) — Future design only; not implemented behavior.

## Documentation maintenance

Edit Desktop behavior here. App owns hooks, public distributions, and Desktop behavior; Web owns cloud API and authentication contracts. Web publishes a pinned App snapshot alongside its own guides. Markdown uses English and lowercase-hyphen filenames, except existing Korean design and verification documents.

[Repository overview](../README.md) · [Downloads](https://github.com/opspresso/vibemon-app/releases/latest)
