# Product design

VibeMon Desktop and Web share one visual language. Desktop adds local activity and companion settings. Web adds account, token, and collection management.

![VibeMon identity in light, dark, App, and small-icon treatments](images/brand-identity.png)

## Shared foundation

`src/shared/design/tokens.css` owns the product palette, typography family, radii, control height, sidebar width, and motion duration. `src/engine/vibemon-companion.mjs` owns the V silhouette and eye bounds; `brand-mark.svg` is its generated product mark. `presentation.mjs` owns state priority, labels, provider names, numeric precision, and relative observation times. These files are public exports in `web-distribution.json`. Web imports a pinned copy; change the App source and sync the Web snapshot before changing either client.

Use violet for actions and active work, teal for healthy states, amber for attention, and rose for errors. A measurement's magnitude does not imply failure: only plan limits have usage thresholds. Always pair color with a state label. Unavailable measurements are distinct from zero. Trend selectors show units once; axis labels use scientific notation for very large or tiny values, while readings and tooltips retain their precision. Stale observations retain their receipt time.

The brand mark is an attentive companion shaped around the initial **V**. Two eyes are cut out of a single rounded silhouette, so the mark keeps its expression in one color and against either theme. The upward tips suggest awareness; the rounded base connects the technical workspace to its friendly desktop companion. Keep the square view box and transparent eye apertures. Do not add outlines, enclosing cubes, or state-dependent details to the mark.

App icons and Web favicons derive from the same geometry and fixed sidebar colors. On macOS, run `node assets/generators/generate-icons.js` after changing those sources. It writes the SVG mark, 128px VibeMon sprite, App PNG, Windows ICO, macOS ICNS, and Web favicon files together. Small frames enlarge the filled mark within the tile; they do not depend on fine strokes. Inspect the eye openings at 16px and 32px, then commit the generated assets and sync the public App revision into Web.

The default VibeMon companion shares the logo's silhouette in 2D and 3D. Its 128px sprite has 14×24px eyes starting at (39, 60) and (75, 60). These are top-left bounds, not eye centers. The generator verifies the registry against the shared geometry; blink, closed-eye, happy-eye, and glasses overlays use those bounds. The 3D rig maps the same anchors onto its beveled face. Other provider characters keep their existing artwork, eye coordinates, and 3D rig.

![VibeMon ready, working, and resting in 2D and 3D](images/companion-identity.png)

## Workspace

Keep primary navigation in this order: **Overview**, **Resources**, **Coding agents**. Put account or device settings below it. The page header names the current task and provides its primary action. **Customize view** controls source and metric selection without occupying the monitoring canvas.

Cards use the same hierarchy: identity, state, measurements, observation time, and **Details**. Keep each provider/account separate. A card's attention state includes all its reporting projects. Details contain the full project list and recent history.

Use the system font, readable secondary text, consistent gaps, and a visible keyboard focus ring. At narrow sizes, reduce columns before shrinking labels. Dialogs must support Escape, contain keyboard focus, and return focus to their trigger. Input values must survive background refreshes.

The shared animation policy pauses character loops when their page is hidden or the OS requests reduced motion. Reduced motion uses a still pose that updates with the current status; it does not freeze status reporting. Speech-bubble loading dots and metric transitions also stop moving. Visibility and preference listeners are removed with the renderer.

## Verification

Run `pnpm test:design` for shared presentation regressions. Compare both clients with the same synthetic resources and accounts in light and dark themes. Check narrow screens, long names, unavailable values, stale data, loading, failures, empty workspaces, keyboard navigation, and reduced motion. Validate collection and editing separately from visual previews; previews must not use production credentials or publish synthetic observations.
