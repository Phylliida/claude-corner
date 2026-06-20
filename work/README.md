# InfiniteDraw

An infinite-zoom drawing canvas with a stop-motion **flipbook**, in plain
JS + HTML + CSS — plus a Playwright-driven browser test suite so it can be
extensively, automatically tested.

Open `index.html` directly in a browser (works over `file://`), or:

```bash
npm run serve   # python3 -m http.server 8080  ->  http://localhost:8080
```

## Features

**Canvas**
- Infinite pan & zoom. Scroll to zoom toward the cursor; drag (or middle-mouse /
  hold <kbd>Space</kbd>) to pan. The zoom range is effectively unbounded.
- Tools: pen, straight line, rectangle, ellipse, stroke-eraser, eyedropper,
  **select**, pan.
- Color picker + quick palette, **background colour**, brush-size slider,
  **brush opacity**, optional **pen smoothing** (quadratic curves).
- **Velocity taper** (toggle <kbd>T</kbd>): the pen varies its width with drawing
  speed — fast strokes go thin, slow strokes go thick, for an organic ink /
  calligraphy feel. The "Taper amt" slider sets how dramatic the thinning is.
- **Selection tool** (<kbd>V</kbd>): marquee-select strokes, then move, scale, or
  delete them. Drag a marquee to select — **left→right** is a *window* (solid
  blue; only fully-enclosed strokes), **right→left** is a *crossing* (dashed
  green; any touched stroke), the AutoCAD convention. Drag inside the selection
  to move it, grab one of the 8 handles to scale (taper widths scale too),
  arrow keys to nudge (<kbd>Shift</kbd> for ×10), <kbd>Delete</kbd> to remove,
  <kbd>Ctrl/⌘+J</kbd> to duplicate. <kbd>Shift</kbd>+drag/click adds to the
  selection, <kbd>Ctrl/⌘+A</kbd> selects all, <kbd>Esc</kbd> clears. All
  transforms are undoable.
- Adaptive dot grid with an origin crosshair (toggle with <kbd>G</kbd>).
- **Minimap / locator** (top-right): an overview of the whole drawing with a live
  viewport rectangle showing where you are. Click or drag it to jump the camera.
  Toggle with <kbd>M</kbd>.
- Undo / redo for every mutation (command stack).
- Reset view, **fit to drawing**.

**Zoom-aware line width** (fix #1)
- Strokes are stored in *world* coordinates, including their width.
- With **Zoom-aware width** on (default), a new stroke's world width is
  `brushSize / zoom`, so it is laid down at exactly `brushSize` on-screen pixels
  no matter how far you're zoomed in or out — and then scales naturally with the
  art as you keep zooming. Toggle it off to get a fixed world width (old
  behaviour) for comparison.

**Flipbook / stop-motion** (feature #2)
- Frames panel: add, duplicate, delete, reorder (drag the ⋮⋮ handle), **reverse
  order**, and **copy / paste** strokes between frames.
- Navigate frames; **play / pause** at an adjustable FPS, with optional looping
  or **ping-pong** (bounce) playback.
- **Per-frame hold** (stop-motion timing): hold any frame for ×N ticks — shown
  as a badge on its thumbnail and used for both playback and GIF frame delays.
- **Onion skinning** with adjustable depth — previous frames ghost in red, next
  frames in blue.
- Per-frame thumbnails.

**Save / export**
- Autosaves to `localStorage`; manual Save too.
- Export / import the whole project as JSON.
- Export the current view as PNG.
- Export the animation as an animated **GIF** (built-in LZW encoder, `gif.js`).

## Keyboard shortcuts

| key | action | key | action |
|----|----|----|----|
| `P` `L` `R` `O` `E` `I` | pen / line / rect / ellipse / eraser / eyedropper | `V` / `H` / `Space` | select / pan |
| `[` `]` | brush size | `C` / `X` | focus color / swap recent |
| `0` | reset view | `F` | fit to drawing |
| `G` / `M` / `T` | toggle grid / minimap / taper | `Ctrl/⌘+Z` / `+Shift` | undo / redo |
| `Ctrl/⌘+A` | select all | `Delete` / `Esc` | delete selection / clear |
| `Ctrl/⌘+J` | duplicate selection | `←↑→↓` (`+Shift`) | nudge selection 1px (10px) |
| `N` | new frame | `D` | duplicate frame |
| `,` `.` | prev / next frame | `Enter` | play / pause |
| `Ctrl/⌘+C` / `+V` | copy / paste frame strokes | `Ctrl/⌘+S` | save |

## Testing

The app exposes a complete API on `window.App` so it can be driven
deterministically, and the suite also exercises real mouse/wheel/keyboard input.

```bash
npm test                 # run everything
node test/run.cjs camera # run only the matching file(s)
```

The suite launches Chromium via Playwright. In this NixOS sandbox the bundled
`chrome-headless-shell` can't run (missing glibc loader), so `test/env.cjs`
auto-discovers a nix-store chromium and points Playwright at it via
`executablePath`. Override with `INFINITEDRAW_CHROMIUM=/path/to/chromium`.

See `NOTES.md` for architecture details and the running TODO list.
