# Product design

VibeMon Desktop and Web share one visual language. Desktop adds local activity and companion settings. Web adds account, token, and collection management.

## Shared foundation

`src/shared/design/tokens.css` owns the product palette, typography family, radii, control height, sidebar width, and motion duration. `brand-mark.svg` owns the product mark. `presentation.mjs` owns state priority, labels, provider names, numeric precision, and relative observation times. These files are public exports in `web-distribution.json`. Web imports a pinned copy; change the App source and sync the Web snapshot before changing either client.

Use violet for actions and active work, teal for healthy states, amber for attention, and rose for errors. A measurement's magnitude does not imply failure: only plan limits have usage thresholds. Always pair color with a state label. Unavailable measurements are distinct from zero. Stale observations retain their receipt time.

## Workspace

Keep primary navigation in this order: **Overview**, **Resources**, **Coding agents**. Put account or device settings below it. The page header names the current task and provides its primary action. **Customize view** controls source and metric selection without occupying the monitoring canvas.

Cards use the same hierarchy: identity, state, measurements, observation time, and **Details**. Keep each provider/account separate. A card's attention state includes all its reporting projects. Details contain the full project list and recent history.

Use the system font, readable secondary text, consistent gaps, and a visible keyboard focus ring. At narrow sizes, reduce columns before shrinking labels. Dialogs must support Escape, contain keyboard focus, and return focus to their trigger. Input values must survive background refreshes.

## Verification

Run `pnpm test:design` for shared presentation regressions. Compare both clients with the same synthetic resources and accounts in light and dark themes. Check narrow screens, long names, unavailable values, stale data, loading, failures, empty workspaces, keyboard navigation, and reduced motion. Validate collection and editing separately from visual previews; previews must not use production credentials or publish synthetic observations.
