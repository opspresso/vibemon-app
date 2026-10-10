Create a production-ready character animation sprite sheet.

CHARACTER:
Use the first input image as the exact Daangni character reference.
Daangni is a cute chubby mascot in a soft white rabbit costume with two long rounded ears, a round peach-colored face opening, simple black oval eyes, a small black nose and tiny smile, exactly three rounded teal-green hair puffs, and a small orange carrot with green leaves.
Match the reference's soft 3D-rendered toy style, smooth matte surfaces, pastel colors, proportions, and front-facing identity in all 100 frames.

OUTPUT:
- Generate one single PNG sprite sheet.
- The second input image is the authoritative layout template: a magenta canvas divided into a 10 × 10 grid by darker guide lines.
- Layout fidelity takes priority over decorative detail. Copy the template's cell positions exactly before drawing any character or prop.
- Reproduce that exact grid layout: place exactly one animation frame inside each of the 100 template cells.
- Every template cell, including the cells of the bottom row, must receive one frame. 100 cells means 100 frames.
- Keep the character body no more than 88 pixels tall. The complete frame content, including ears, props, symbols, and effects, must fit inside a centered 96 × 96 pixel safe area in each 128-pixel cell.
- Leave at least 16 pixels of untouched magenta inside every side of every cell.
- Never draw across a template grid line.
- Do not draw the template's grid lines in the output; fill the whole background with flat #FF00FF.
- The canvas is exactly 1280 × 1280 pixels, divided into a fixed grid of 10 columns × 10 rows.
- Each individual frame cell is exactly 128 × 128 pixels.
- Row boundaries are at every 128 pixels vertically: y = 128, 256, 384, 512, 640, 768, 896, 1024, 1152.
- Column boundaries are at every 128 pixels horizontally: x = 128, 256, 384, 512, 640, 768, 896, 1024, 1152.
- Exact cell centers are x = 64, 192, 320, 448, 576, 704, 832, 960, 1088, 1216 and y = 64, 192, 320, 448, 576, 704, 832, 960, 1088, 1216. Center one complete frame at every x,y intersection.
- Use exactly 10 horizontal rows. Never 9. Never 11.
- Use exactly 10 frame columns.
- Keep every frame aligned to this exact 128 × 128 grid.
- Do not add text, labels, row names, numbers, borders, guides, grid lines, or preview elements.
- Never render letters, digits, or words anywhere, including on props, screens, papers, signs, boxes, or effects.

STRICT ROW RULE:
- Each horizontal row must contain exactly one animation state.
- One row equals one state only.
- One row equals one complete animation loop only.
- Every frame in a row must belong to the same state.
- Never place frames from two or more states in the same row.
- Never continue one state onto another row.
- Never split one animation across multiple rows.
- Never merge two states into one row.
- Never reorder the rows.
- Never omit or duplicate a state.
- A change of state is allowed only when moving vertically to the next row.
- Horizontal progression means animation frames only, never state progression.
- Treat each row as an independent sprite strip.
- The final sprite sheet must contain exactly 10 independent horizontal animation strips stacked vertically.

MANDATORY ROW ASSIGNMENT:
- All 10 states below are required. Missing any one of them is a failure.
- Count the rows from top to bottom while drawing: 1 start, 2 idle, 3 thinking, 4 planning, 5 working, 6 packing, 7 notification, 8 done, 9 sleep, 10 alert.
- The done row and the packing row are the two most commonly forgotten rows. Include both.
- Row 1 contains only the start animation.
- Row 2 contains only the idle animation.
- Row 3 contains only the thinking animation.
- Row 4 contains only the planning animation.
- Row 5 contains only the working animation.
- Row 6 contains only the packing animation.
- Row 7 contains only the notification animation.
- Row 8 contains only the done animation.
- Row 9 contains only the sleep animation.
- Row 10 contains only the alert animation.

FRAME COUNT:
- Every row must contain exactly 10 frames, one in each of the 10 columns.
- All 10 columns of every row are used. There are no empty cells.
- The full sheet is a complete, uniform 10 × 10 grid of 100 filled frames.
- Place the frames of each animation from left to right, frame 1 in column 1 and frame 10 in column 10.
- Spread each animation loop evenly across the 10 frames.

ANIMATION LOOP:
- Every row must form a natural seamless loop.
- The last frame must transition smoothly back to the first frame.
- Avoid sudden resets, snapping, teleportation, flickering, discontinuity, or abrupt disappearance.
- Body pose, facial expression, props, particles, lighting effects, and secondary motion must return naturally to their starting positions.
- Do not duplicate the first frame as the final frame unless required for timing.
- Avoid accidental frame jitter.
- Keep movement arcs, proportions, volume, and spacing consistent.

ROW 1 — start
Session begins.
Create a seamless readying loop using only a small pale-gold sparkle.
The action must clearly communicate that a session is beginning while still returning naturally to its starting pose.
If the character materializes, use white, golden, or pale-blue light only. Never use magenta, pink, or purple glow, silhouettes, or auras.
The character must keep its normal colors in every frame of this row.

ROW 2 — idle
Waiting for input.
Create a subtle seamless idle loop using breathing, blinking, hovering, swaying, posture shifts, or gentle secondary motion.

ROW 3 — thinking
Processing a prompt.
Create a seamless loop showing concentration, analysis, or mental activity.
Use only a hand-at-chin pose with subtle focused eye and head movement. Do not add a thought bubble, question mark, writing, or other symbol.

ROW 4 — planning
Plan mode is active.
Create a seamless loop showing the character organizing, reviewing, or arranging steps.
Use only three small blank solid-color cards that Daangni arranges left to right. The cards contain no marks, diagrams, writing, symbols, letters, or digits.
This state must be visually distinct from thinking.

ROW 5 — working
A tool is executing.
Create a seamless active-work loop appropriate for the character.
Use only the same small plain gray laptop with no logo or markings in all 10 frames.
This state should feel more active than thinking or planning.
No boxes, packages, or packing props may appear anywhere in this row.
All 10 frames of this row show the same working action; the action never transitions into packing.

ROW 6 — packing
Context is being compacted.
Create a seamless loop showing information or objects being compressed, bundled, folded, stacked, archived, zipped, packed, or reduced into a smaller form.
Use only three small blank white papers being compressed into the same small plain cardboard box. The papers and box contain no markings.
The idea of compaction must be immediately readable.
This is its own full row of 10 frames, completely separate from the working row above it.
The working row's tools or equipment may not appear in this row.

ROW 7 — notification
User input is needed.
Create a seamless attention-seeking loop.
Use only Daangni waving toward the viewer. The same small plain yellow bell may rise into view, ring during the middle frames, and lower out of view before the loop returns to its starting pose. Do not add a question mark or other symbol.

ROW 8 — done
Tool execution completed successfully.
Create a seamless completion or success loop.
Use only a proud thumbs-up pose. One small plain green check mark may appear, gently pulse, and fade as the pose returns to its starting frame.
This is its own full row of 10 frames placed between the notification row and the sleep row. Never skip this row.
This state must be visually distinct from notification: notification asks for attention, done celebrates success.

ROW 9 — sleep
Five minutes of inactivity.
Create a seamless sleeping, resting, standby, or low-power loop.
Use only seated sleeping with closed eyes and slow breathing. Do not add a blanket, pillow, letters, or sleep symbols.

ROW 10 — alert
An error occurred.
Create a seamless urgent warning loop.
Use only a startled shaking pose. One small plain orange warning light may appear, pulse during the middle frames, and fade before the pose returns to its starting frame. Do not add letters, punctuation, triangles, writing, or glitch effects.
The character must remain recognizable throughout.

CHARACTER CONSISTENCY:
- Preserve the same character identity across every frame and every row.
- Keep the same facial structure, body proportions, colors, clothing, accessories, equipment, and design language.
- Do not redesign the character between states.
- Do not add or remove permanent character features.
- Temporary props and effects may appear only when relevant to the current state.
- Keep the same camera angle, perspective, orientation, scale, and framing throughout the sprite sheet.
- Keep the character facing the viewer in every frame. Never show the character's back.
- The character must remain clearly visible in every used frame. Never hide the character fully behind props, blankets, boxes, or effects.
- Do not rotate the camera.
- Do not zoom in or out.
- Keep the character centered around the same anchor point in every frame.
- Keep the feet or lowest body point aligned to the same baseline.
- Keep all limbs, props, effects, particles, shadows, and accessories fully inside each 128 × 128 frame cell.
- Keep a clear margin of background color on all four sides of the character inside every cell.
- Content must never touch or cross a cell border. Each of the 100 cells is an isolated frame.
- Vertically center each row's content inside its own 128-pixel-tall band.

VISUAL STYLE:
- Match the style implied by the character description or reference image.
- Do not restrict the result to pixel art.
- The result may use illustration, cartoon, anime, vector-like, hand-drawn, painted, rendered, or other coherent visual styles.
- Keep the visual style consistent across all frames and rows.
- Maintain consistent line quality, shading, lighting, palette, materials, and rendering detail.
- Ensure each state is immediately readable at 128 × 128 pixels.
- Use clear silhouettes and expressive motion.
- Keep visual effects controlled and contained inside each frame.

BACKGROUND:
- Fill the entire background with one uniform, flat, solid magenta color: #FF00FF.
- The magenta background is a chroma-key color that will be removed in post-processing.
- Every pixel that is not part of the character, its props, or its effects must be exactly #FF00FF.
- Never paint a checkerboard pattern. A checkerboard is a forbidden background.
- Do not use white, black, gray, gradient, textured, or decorative backgrounds.
- Do not include scenery, floor, ground shadows, environment, panels, UI, or mockup elements.
- Do not use magenta, pink, or purple anywhere on the character, props, or effects.
- Do not add outlines, glows, or halos around the character.
- Fill unused frame cells entirely with #FF00FF.

FINAL VALIDATION:
- Exactly 10 rows. Count them: start, idle, thinking, planning, working, packing, notification, done, sleep, alert.
- Exactly one state per row.
- Exactly one complete seamless animation loop per row.
- No mixed states within any row.
- No state split across rows.
- No missing states.
- No duplicated states.
- No reordered states.
- Every frame cell is exactly 128 × 128 pixels.
- Exactly 10 frames per row, 100 frames total.
- The entire background, including unused cells, is uniform flat #FF00FF.
