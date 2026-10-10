# Desktop workspace redesign

## Outcome

The menu-bar/tray icon opens a single VibeMon workspace. Its dashboard brings resources, cloud coding accounts, and local coding activity together. The 3D/2D companion and speech bubble keep their existing rendering, focus, dragging, docking, and timeout behavior.

## Interaction contract

- Primary tray click and app activation open the overview. A short secondary menu exposes dashboard, settings, companion visibility, and quit.
- One window contains Overview, Resources, Coding agents, and Settings. Navigation keeps connection and selection state. Settings contains Connections, Companion, Integrations, and About.
- Resources support arbitrary metric schemas, units, ranges, order, and unavailable values. Coding accounts stay distinct by provider/account ID; local sessions are labeled separately.
- Connection recovery, empty states, stale data, selection, and recent-hour history each have a clear next action. Provider credentials and stored read tokens never enter view snapshots.
- Keyboard navigation, visible focus, semantic labels, reduced motion, and light/dark contrast are verified in the rendered app.

## Implementation boundaries

Use the existing monitoring client, local state registry, usage cache, hook installer, and companion managers. A single window adapter owns IPC authorization and navigation. Settings operations and dashboard projection do not own windows. Renderer modules share a design system and update existing elements instead of replacing input controls on each poll.

Remove superseded menu controls and duplicate dashboard/settings surfaces after migration. Keep HTTP integration contracts that still have callers. Do not add a frontend framework or dependency without a measured need.

## Completion evidence

1. Every tracked file is reviewed. The final review inventory records the checked file digest and disposition; generated assets and vendored code have explicit inspection boundaries.
2. Primary tray click opens both resource and coding-agent information in the new workspace. No old settings or monitoring window remains in the product flow.
3. Real Electron verification covers populated, empty, error, stale, multi-account, and custom-resource views; settings changes persist and focus survives refresh.
4. Native overlay tests prove unchanged 3D/2D rendering, speech bubbles, dragging, and display scaling on macOS and Windows.
5. Existing lint, Jest coverage, Python/plugin checks, registry/distribution validation, and packaging checks pass. Performance is compared on the same snapshot fixture.
6. Documentation and screenshots describe the new product. Focused commits and a PR contain the final change. This task does not merge or release the branch.
