/**
 * VibeMon speech bubble rendering
 *
 * Canonical shared module for turning status field data into the speech
 * bubble's DOM: status text + loading dots, project/model text rows, and
 * memory/usage metric rows (icon + inline bar + percentage). Also exports
 * the pure color/format helpers those rows use.
 *
 * This module only fills in a bubble element's content and points its tail
 * at one of the four edges — it has no opinion on where the bubble itself
 * sits on screen. vibemon-app's bubble.html additionally positions the
 * bubble window and the tail's offset along that edge via a d3-force
 * simulation against the character window (see
 * src/modules/bubble-window-manager.cjs) — that placement logic is
 * desktop-specific and lives only in vibemon-app.
 *
 * This file is the source of truth, consumed at build time only —
 * vibemon-app vendors a copy (see its check-registry script), and vibemon
 * vendors the full module but imports just the pure helpers (barColor,
 * formatMinutes, pickTextColor) since its speech bubble renders as
 * JSX/CSS-modules, not this module's DOM structure. No page on this site
 * imports it at runtime.
 *
 * Expected bubble element structure (see vibemon-bubble.css):
 *   <div class="bubble">
 *     <div class="bubble-tail"></div>
 *     <div class="bubble-row" data-field="status">
 *       <span class="bubble-status-text"></span>
 *       <span class="bubble-dots"><span class="bubble-dot"></span>x4</span>
 *     </div>
 *     <div class="bubble-row" data-field="project"></div>
 *     <div class="bubble-row" data-field="model"></div>
 *     <div class="bubble-row bubble-metric" data-field="memory">
 *       <span class="bubble-icon"></span>
 *       <span class="bubble-bar-track"><span class="bubble-bar-fill"></span></span>
 *       <span class="bubble-value"></span>
 *     </div>
 *     <!-- usage5h / usageWeek / usageWeekModel follow the same metric-row shape -->
 *   </div>
 * Only the rows actually present in a given page's markup are touched, so a
 * page that only cares about status+dots can omit the rest.
 *
 * Usage:
 *   renderBubble(bubbleEl, {
 *     status: { type: 'text', text: 'Thinking', showLoading: true, slow: true },
 *     project: { type: 'text', text: '📁 my-project' },
 *     memory: { type: 'metric', icon: '🧠', value: 45, resetIn: 24 }
 *   }, 'left', '#9933FF', { opaque: true });
 *
 * The optional 5th argument's `opaque` flag (default false) picks between a
 * solid `bgColor` background/tail and the default translucent
 * `bgRgba(bgColor, 0.9)` — the latter suits vibemon-app's floating desktop
 * overlay, the former matches vibemon's opaque card-style bubble.
 */

// Same green/yellow/orange/red thresholds as statusline.py's C_GREEN/C_YELLOW/C_ORANGE/C_RED.
export function barColor(percent) {
  if (percent > 90) return '#FF4444';
  if (percent > 70) return '#FF8800';
  if (percent > 50) return '#FFCC00';
  return '#00AA00';
}

// Minutes until a usage quota resets, formatted compactly: "24m", "2h5m", "3d4h".
export function formatMinutes(mins) {
  mins = Math.max(0, Math.round(mins));
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? hours + 'h' + remMins + 'm' : hours + 'h';
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? days + 'd' + remHours + 'h' : days + 'd';
}

export function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const num = parseInt(h, 16);
  if (Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function bgRgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
}

// Pick black or white text depending on how light the state-colored
// background reads.
export function pickTextColor(hex) {
  const c = hexToRgb(hex);
  const luminance = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  return luminance > 140 ? '#1a1a1a' : '#ffffff';
}

// Loading dots beside the status text: all four pulse together via the CSS
// `bubble-dots.slow`/`.fast` animations (see vibemon-bubble.css) — this just
// toggles visibility and picks the pace.
function setDots(dotsEl, show, slow) {
  dotsEl.style.display = show ? 'inline-flex' : 'none';
  dotsEl.classList.toggle('slow', show && Boolean(slow));
  dotsEl.classList.toggle('fast', show && !slow);
}

/**
 * Fill a bubble element's rows from field data and point its tail at one
 * edge. `fields` is a plain object keyed by field name: { type: 'text', text }
 * for status/project/model (status may also carry showLoading/slow to
 * animate the loading dots), or { type: 'metric', icon, value, resetIn, label }
 * (value is 0-100; the optional label prefixes the percentage, e.g. a
 * model-scoped usage row's model name) for memory/usage rows. Only enabled/truthy fields are
 * present; rows with no matching field are hidden. `tailSide` is one of
 * 'top'/'bottom'/'left'/'right'; `bgColor` is the current state's hex color,
 * used for both the bubble's background and its text/tail color. `opts.opaque`
 * (default false) picks a solid vs. translucent background — see the module
 * docstring above.
 */
export function renderBubble(bubbleEl, fields, tailSide, bgColor, opts) {
  const opaque = Boolean(opts && opts.opaque);

  if (bgColor) {
    bubbleEl.style.background = opaque ? bgColor : bgRgba(bgColor, 0.9);
    bubbleEl.style.color = pickTextColor(bgColor);
  }

  const rows = bubbleEl.querySelectorAll('.bubble-row');
  for (const row of rows) {
    const data = fields[row.dataset.field];
    if (!data) {
      if (row.dataset.field === 'status') {
        const dotsEl = row.querySelector('.bubble-dots');
        if (dotsEl) setDots(dotsEl, false, false);
      }
      row.style.display = 'none';
      continue;
    }

    if (data.type === 'metric') {
      const icon = row.querySelector('.bubble-icon');
      const fill = row.querySelector('.bubble-bar-fill');
      const value = row.querySelector('.bubble-value');
      if (!icon || !fill || !value) {
        row.style.display = 'none';
        continue;
      }
      const pct = Math.max(0, Math.min(100, Number(data.value) || 0));
      icon.textContent = data.icon;
      fill.style.width = pct + '%';
      fill.style.background = barColor(pct);
      const pctText = typeof data.resetIn === 'number'
        ? `${pct}% · ${formatMinutes(data.resetIn)}`
        : `${pct}%`;
      value.textContent = data.label ? `${data.label} ${pctText}` : pctText;
      row.style.display = 'flex';
    } else if (row.dataset.field === 'status') {
      const textEl = row.querySelector('.bubble-status-text');
      if (textEl) textEl.textContent = data.text;
      const dotsEl = row.querySelector('.bubble-dots');
      if (dotsEl) setDots(dotsEl, Boolean(data.showLoading), Boolean(data.slow));
      row.style.display = 'flex';
    } else {
      row.textContent = data.text;
      row.style.display = 'block';
    }
  }

  const tail = bubbleEl.querySelector('.bubble-tail');
  if (!tail) return;

  const sides = ['top', 'bottom', 'left', 'right'];
  if (sides.includes(tailSide)) {
    for (const side of sides) tail.classList.toggle(`tail-${side}`, tailSide === side);
  }
  if (bgColor) {
    const tailColor = opaque ? bgColor : bgRgba(bgColor, 0.9);
    tail.style.borderTopColor = tailSide === 'bottom' ? tailColor : '';
    tail.style.borderBottomColor = tailSide === 'top' ? tailColor : '';
    tail.style.borderRightColor = tailSide === 'left' ? tailColor : '';
    tail.style.borderLeftColor = tailSide === 'right' ? tailColor : '';
  }
}
