# Desktop workspace redesign

## Outcome

Select **Dashboard** from the menu-bar/tray menu to open the VibeMon workspace. Its dashboard brings resources, cloud agent accounts, and local coding activity together. The 3D/2D companion and speech bubble keep their existing rendering, focus, dragging, docking, and timeout behavior.

## Interaction contract

- Primary and secondary tray clicks open the navigation menu. Selecting **Dashboard** opens the overview. App activation also opens the overview.
- One window contains Overview, Agents, Resources, and Settings. Navigation keeps connection and selection state. Settings contains Connections, Companion, Integrations, and About.
- Menus, overview sections, and display choices put **Agents** before **Resources**. Agents keep their per-provider account identity; account pickers say **Agent account**.
- Numbers keep their existing precision. Decimal separators and fractional digits use a smaller, slightly lighter style; Increase Contrast retains full color.
- Resources support arbitrary metric schemas, units, ranges, order, and unavailable values. Agent accounts stay distinct by provider/account ID; local sessions are labeled separately.
- Connection recovery, empty states, stale data, selection, and recent-hour history each have a clear next action. Provider credentials and stored read tokens never enter view snapshots.
- Keyboard navigation, visible focus, semantic labels, reduced motion, and light/dark contrast are verified in the rendered app.

## Implementation boundaries

Use the existing monitoring client, local state registry, usage cache, hook installer, and companion managers. A single window adapter owns IPC authorization and navigation. Settings operations and dashboard projection do not own windows. Renderer modules share a design system and update existing elements instead of replacing input controls on each poll.

Remove superseded menu controls and duplicate dashboard/settings surfaces after migration. Keep HTTP integration contracts that still have callers. Do not add a frontend framework or dependency without a measured need.

## Completion evidence

1. Every tracked file is reviewed. The final review inventory records the checked file digest and disposition; generated assets and vendored code have explicit inspection boundaries.
2. Clicking the tray icon shows the menu without opening the workspace. Selecting **Dashboard** opens both resource and coding-agent information. No old settings or monitoring window remains in the product flow.
3. Real Electron verification covers populated, empty, error, stale, multi-account, and custom-resource views; settings changes persist and focus survives refresh.
4. Native overlay tests prove unchanged 3D/2D rendering, speech bubbles, dragging, and display scaling on macOS and Windows.
5. Existing lint, Jest coverage, Python/plugin checks, registry/distribution validation, and packaging checks pass. Performance is compared on the same snapshot fixture.
6. Documentation and screenshots describe the new product. Focused commits and a PR contain the final change.
