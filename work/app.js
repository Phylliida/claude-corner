/* InfiniteDraw — infinite-zoom drawing canvas with a stop-motion flipbook.
 *
 * Coordinate model
 * ----------------
 * Strokes are stored in WORLD coordinates. The camera maps world -> screen:
 *     screen = (world - cam) * scale
 *     world  = screen / scale + cam
 * `cam` is the world coordinate sitting at the canvas top-left (CSS pixels).
 * Because strokes live in world space, zooming/panning is just a camera change;
 * the drawing itself is resolution-independent and the zoom range is effectively
 * unbounded ("infinite zoom").
 *
 * Line width (fix #1)
 * -------------------
 * Each stroke stores its width in WORLD units. When "zoom-aware width" is on, a
 * new stroke's world width is (brushSize / scale), so it is laid down at exactly
 * `brushSize` on-screen pixels regardless of the current zoom, and then scales
 * naturally with the drawing as you zoom afterwards. When off, the brush size is
 * treated as a fixed world width (old behaviour) for comparison.
 *
 * Everything the UI does is also reachable through window.App so the Playwright
 * suite can drive the app deterministically.
 */
(function () {
  "use strict";

  const CONFIG = {
    MIN_SCALE: 1e-4,
    MAX_SCALE: 2e4,
    MIN_RENDER_WIDTH: 0.2, // never let a line vanish entirely
    ERASER_SCREEN_RADIUS: 10, // base, multiplied by brush size factor
    AUTOSAVE_MS: 400,
    STORAGE_KEY: "infinitedraw:v2",
    PALETTE: ["#ffffff", "#34d2ff", "#ff6b6b", "#ffd166", "#7cfc8a", "#c792ea", "#000000"],
  };

  // ---- DOM ----
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const $ = (id) => document.getElementById(id);

  // ---- State ----
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  let nextId = 1;
  function uid() { return nextId++; }

  function makeFrame(strokes, hold) {
    return { id: uid(), strokes: strokes || [], hold: Math.max(1, hold || 1) };
  }

  const state = {
    cam: { x: 0, y: 0 },
    scale: 1,
    frames: [makeFrame()],
    current: 0,
    tool: "pen",
    color: "#34d2ff",
    prevColor: "#ff6b6b",
    brushSize: 6, // on-screen px (when zoom-aware) or world units (when not)
    opacity: 1, // 0..1 stroke alpha for new strokes
    zoomDependent: true,
    smooth: true, // render pen paths as smooth curves
    grid: true,
    minimap: true,
    bg: "#0d0f15",
    // flipbook
    fps: 8,
    onion: false,
    onionDepth: 1,
    loop: true,
    pingpong: false,
    playing: false,
    playDir: 1,
  };

  // In-progress drawing
  let drawing = null; // { type, color, width, points: [...] }
  let panState = null; // { startScreen, startCam }
  let spaceHeld = false;
  let playTimer = null;
  let saveTimer = null;
  let suppressSave = false;

  // ---- History (command stack) ----
  const undoStack = [];
  const redoStack = [];

  function commit(action) {
    action.do();
    undoStack.push(action);
    redoStack.length = 0;
    afterChange();
  }
  function undo() {
    const a = undoStack.pop();
    if (!a) return false;
    a.undo();
    redoStack.push(a);
    afterChange();
    return true;
  }
  function redo() {
    const a = redoStack.pop();
    if (!a) return false;
    a.do();
    undoStack.push(a);
    afterChange();
    return true;
  }

  // ---- Geometry ----
  function worldToScreen(wx, wy) {
    return { x: (wx - state.cam.x) * state.scale, y: (wy - state.cam.y) * state.scale };
  }
  function screenToWorld(sx, sy) {
    return { x: sx / state.scale + state.cam.x, y: sy / state.scale + state.cam.y };
  }
  function clampScale(s) { return Math.min(CONFIG.MAX_SCALE, Math.max(CONFIG.MIN_SCALE, s)); }

  function zoomAt(sx, sy, factor) {
    const newScale = clampScale(state.scale * factor);
    if (newScale === state.scale) return;
    const w = screenToWorld(sx, sy);
    state.scale = newScale;
    state.cam.x = w.x - sx / newScale;
    state.cam.y = w.y - sy / newScale;
    render();
    updateZoomLabel();
    scheduleSave();
  }
  function setZoom(scale, sx, sy) {
    const W = cssW(), H = cssH();
    sx = sx == null ? W / 2 : sx;
    sy = sy == null ? H / 2 : sy;
    zoomAt(sx, sy, clampScale(scale) / state.scale);
  }
  function panBy(dxScreen, dyScreen) {
    state.cam.x -= dxScreen / state.scale;
    state.cam.y -= dyScreen / state.scale;
    render();
    scheduleSave();
  }
  function resetView() {
    state.scale = 1;
    state.cam.x = -cssW() / 2;
    state.cam.y = -cssH() / 2;
    render();
    updateZoomLabel();
    scheduleSave();
  }

  function contentBounds(strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.points) {
        const r = s.width / 2;
        if (p.x - r < minX) minX = p.x - r;
        if (p.y - r < minY) minY = p.y - r;
        if (p.x + r > maxX) maxX = p.x + r;
        if (p.y + r > maxY) maxY = p.y + r;
      }
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  function fitView(strokes) {
    const b = contentBounds(strokes || frame().strokes);
    if (!b) { resetView(); return; }
    const W = cssW(), H = cssH();
    const pad = 0.12;
    const bw = Math.max(1e-6, b.maxX - b.minX);
    const bh = Math.max(1e-6, b.maxY - b.minY);
    const s = clampScale(Math.min(W / (bw * (1 + pad)), H / (bh * (1 + pad))));
    state.scale = s;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    state.cam.x = cx - W / (2 * s);
    state.cam.y = cy - H / (2 * s);
    render();
    updateZoomLabel();
    scheduleSave();
  }

  // ---- Frames ----
  function frame() { return state.frames[state.current]; }

  function cloneStroke(s) {
    return { id: uid(), type: s.type, color: s.color, width: s.width, alpha: s.alpha, points: s.points.map((p) => ({ x: p.x, y: p.y })) };
  }

  function gotoFrame(i) {
    state.current = Math.max(0, Math.min(state.frames.length - 1, i));
    render();
    updateFrameUI();
    scheduleSave();
  }
  function nextFrame() {
    if (state.current < state.frames.length - 1) gotoFrame(state.current + 1);
    else if (state.loop) gotoFrame(0);
  }
  function prevFrame() {
    if (state.current > 0) gotoFrame(state.current - 1);
    else if (state.loop) gotoFrame(state.frames.length - 1);
  }

  function addFrame() {
    const at = state.current + 1;
    const f = makeFrame();
    commit({
      do: () => { state.frames.splice(at, 0, f); state.current = at; },
      undo: () => { state.frames.splice(at, 1); state.current = Math.max(0, at - 1); },
    });
    toast("Frame added");
  }
  function dupFrame() {
    const at = state.current + 1;
    const copy = makeFrame(frame().strokes.map(cloneStroke), frame().hold);
    commit({
      do: () => { state.frames.splice(at, 0, copy); state.current = at; },
      undo: () => { state.frames.splice(at, 1); state.current = Math.max(0, at - 1); },
    });
    toast("Frame duplicated");
  }
  function delFrame() {
    if (state.frames.length === 1) {
      // Clear instead of deleting the last frame.
      clearFrame();
      return;
    }
    const at = state.current;
    const removed = state.frames[at];
    commit({
      do: () => { state.frames.splice(at, 1); state.current = Math.min(at, state.frames.length - 1); },
      undo: () => { state.frames.splice(at, 0, removed); state.current = at; },
    });
    toast("Frame deleted");
  }
  function moveFrame(from, to) {
    if (from === to || to < 0 || to >= state.frames.length) return;
    commit({
      do: () => { const [f] = state.frames.splice(from, 1); state.frames.splice(to, 0, f); state.current = to; },
      undo: () => { const [f] = state.frames.splice(to, 1); state.frames.splice(from, 0, f); state.current = from; },
    });
  }

  function clearFrame() {
    const f = frame();
    if (f.strokes.length === 0) return;
    const old = f.strokes;
    commit({
      do: () => { f.strokes = []; },
      undo: () => { f.strokes = old; },
    });
    toast("Frame cleared");
  }

  function setFrameHold(i, n) {
    const f = state.frames[i];
    if (!f) return;
    f.hold = Math.max(1, Math.min(99, Math.round(n)));
    updateFrameUI();
    scheduleSave();
  }
  function getFrameHold(i) { return (state.frames[i] && state.frames[i].hold) || 1; }
  // Per-frame GIF delay in centiseconds (hold * base frame time).
  function frameDelaysCs() {
    const base = 100 / state.fps;
    return state.frames.map((f) => Math.max(2, Math.round(base * (f.hold || 1))));
  }

  function reverseFrames() {
    if (state.frames.length < 2) return;
    const n = state.frames.length;
    // reverse() is its own inverse, so do === undo
    const flip = () => { state.frames.reverse(); state.current = n - 1 - state.current; };
    commit({ do: flip, undo: flip });
    toast("Frames reversed");
  }

  // Internal stroke clipboard (copy/paste between frames).
  let clipboard = null;
  function copyFrame() {
    clipboard = frame().strokes.map((s) => ({
      type: s.type, color: s.color, width: s.width, alpha: s.alpha,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));
    toast(clipboard.length ? `Copied ${clipboard.length} stroke(s)` : "Nothing to copy");
    return clipboard.length;
  }
  function pasteFrame() {
    if (!clipboard || !clipboard.length) { toast("Clipboard empty"); return 0; }
    const f = frame();
    const added = clipboard.map((s) => ({
      id: uid(), type: s.type, color: s.color, width: s.width, alpha: s.alpha,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));
    commit({
      do: () => { for (const s of added) f.strokes.push(s); },
      undo: () => { for (const s of added) { const i = f.strokes.indexOf(s); if (i >= 0) f.strokes.splice(i, 1); } },
    });
    toast(`Pasted ${added.length} stroke(s)`);
    return added.length;
  }

  // ---- Drawing primitives ----
  function strokeWorldWidth() {
    return state.zoomDependent ? state.brushSize / state.scale : state.brushSize;
  }

  function addStroke(stroke) {
    const s = stroke.id ? stroke : Object.assign({ id: uid() }, stroke);
    const f = frame();
    commit({
      do: () => { f.strokes.push(s); },
      undo: () => { const i = f.strokes.indexOf(s); if (i >= 0) f.strokes.splice(i, 1); },
    });
    return s;
  }

  // Programmatic stroke building (used by UI pointer handlers and by tests).
  function beginStroke(world, opts) {
    opts = opts || {};
    drawing = {
      type: opts.type || (state.tool === "rect" ? "rect" : state.tool === "ellipse" ? "ellipse" : "path"),
      tool: state.tool,
      color: opts.color || state.color,
      width: opts.width != null ? opts.width : strokeWorldWidth(),
      alpha: opts.alpha != null ? opts.alpha : state.opacity,
      points: [{ x: world.x, y: world.y }],
    };
    render();
  }
  function extendStroke(world) {
    if (!drawing) return;
    if (drawing.type === "path" && drawing.tool === "pen") {
      drawing.points.push({ x: world.x, y: world.y });
    } else {
      // line / rect / ellipse: only first + last matter
      drawing.points[1] = { x: world.x, y: world.y };
    }
    render();
  }
  function endStroke() {
    if (!drawing) return null;
    let committed = null;
    const d = drawing;
    drawing = null;
    if (d.points.length >= 1) {
      // A pen tap with a single point still becomes a dot.
      if (d.type === "path" && d.points.length === 1) {
        d.points.push({ x: d.points[0].x + 0.001, y: d.points[0].y + 0.001 });
      }
      if (d.points.length >= 2 || d.type === "path") {
        committed = addStroke({ type: d.type, color: d.color, width: d.width, alpha: d.alpha, points: d.points });
      }
    }
    render();
    return committed;
  }

  // Eraser: remove strokes near a world point.
  function eraseAt(world, radiusWorld) {
    const f = frame();
    const r = radiusWorld != null ? radiusWorld : (CONFIG.ERASER_SCREEN_RADIUS * (state.brushSize / 6)) / state.scale;
    const removed = [];
    for (let i = f.strokes.length - 1; i >= 0; i--) {
      const s = f.strokes[i];
      if (strokeHit(s, world, r + s.width / 2)) {
        removed.push({ index: i, stroke: s });
      }
    }
    if (!removed.length) return 0;
    commit({
      do: () => { for (const { index } of removed) f.strokes.splice(index, 1); },
      undo: () => { for (let k = removed.length - 1; k >= 0; k--) f.strokes.splice(removed[k].index, 0, removed[k].stroke); },
    });
    return removed.length;
  }

  // Eyedropper: pick the colour of the topmost stroke under a world point.
  function pickColorAt(world) {
    const f = frame();
    for (let i = f.strokes.length - 1; i >= 0; i--) {
      const s = f.strokes[i];
      if (strokeHit(s, world, s.width / 2 + 5 / state.scale)) { setColor(s.color); return s.color; }
    }
    return null;
  }

  function strokeHit(s, p, r) {
    if (s.type === "rect" || s.type === "ellipse") {
      const a = s.points[0], b = s.points[1] || s.points[0];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      // hit if near the outline box
      const nearX = p.x >= x0 - r && p.x <= x1 + r;
      const nearY = p.y >= y0 - r && p.y <= y1 + r;
      const onV = (Math.abs(p.x - x0) <= r || Math.abs(p.x - x1) <= r) && nearY;
      const onH = (Math.abs(p.y - y0) <= r || Math.abs(p.y - y1) <= r) && nearX;
      return onV || onH;
    }
    const pts = s.points;
    for (let i = 1; i < pts.length; i++) {
      if (distToSeg(p, pts[i - 1], pts[i]) <= r) return true;
    }
    if (pts.length === 1) return dist(p, pts[0]) <= r;
    return false;
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ---- Rendering ----
  function cssW() { return canvas.clientWidth || window.innerWidth; }
  function cssH() { return canvas.clientHeight || window.innerHeight; }

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW() * dpr);
    canvas.height = Math.round(cssH() * dpr);
    render();
  }

  function strokeScreenWidth(s) {
    return Math.max(CONFIG.MIN_RENDER_WIDTH, s.width * state.scale);
  }

  function drawStroke(c, s, alpha, tint) {
    c.save();
    const sa = s.alpha == null ? 1 : s.alpha;
    c.globalAlpha = (alpha == null ? 1 : alpha) * sa;
    c.strokeStyle = tint || s.color;
    c.fillStyle = tint || s.color;
    c.lineWidth = strokeScreenWidth(s);
    c.lineJoin = "round";
    c.lineCap = "round";
    const pts = s.points;
    if (s.type === "rect") {
      const a = worldToScreen(pts[0].x, pts[0].y);
      const b = worldToScreen(pts[1].x, pts[1].y);
      c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.type === "ellipse") {
      const a = worldToScreen(pts[0].x, pts[0].y);
      const b = worldToScreen(pts[1].x, pts[1].y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      c.beginPath();
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
    } else {
      const scr = pts.map((p) => worldToScreen(p.x, p.y));
      c.beginPath();
      c.moveTo(scr[0].x, scr[0].y);
      if (state.smooth && s.type === "path" && scr.length > 2) {
        // quadratic smoothing: each real point is a control point, curve ends
        // at the midpoint to the next point (classic signal smoothing).
        for (let i = 1; i < scr.length - 1; i++) {
          const mid = { x: (scr[i].x + scr[i + 1].x) / 2, y: (scr[i].y + scr[i + 1].y) / 2 };
          c.quadraticCurveTo(scr[i].x, scr[i].y, mid.x, mid.y);
        }
        const last = scr[scr.length - 1];
        c.lineTo(last.x, last.y);
      } else {
        for (let i = 1; i < scr.length; i++) c.lineTo(scr[i].x, scr[i].y);
        if (scr.length === 1) c.lineTo(scr[0].x + 0.01, scr[0].y + 0.01);
      }
      c.stroke();
    }
    c.restore();
  }

  function drawGrid(c) {
    if (!state.grid) return;
    const W = cssW(), H = cssH();
    // Choose a world spacing whose on-screen size is ~ 26..260 px.
    const target = 90;
    let spacingWorld = Math.pow(10, Math.round(Math.log10(target / state.scale)));
    let screenSpacing = spacingWorld * state.scale;
    if (screenSpacing < 26) { spacingWorld *= 5; screenSpacing = spacingWorld * state.scale; }
    if (screenSpacing > 260) { spacingWorld /= 2; screenSpacing = spacingWorld * state.scale; }
    const topLeft = screenToWorld(0, 0);
    const startX = Math.floor(topLeft.x / spacingWorld) * spacingWorld;
    const startY = Math.floor(topLeft.y / spacingWorld) * spacingWorld;
    c.save();
    c.fillStyle = "rgba(255,255,255,0.06)";
    for (let wx = startX; ; wx += spacingWorld) {
      const sx = worldToScreen(wx, 0).x;
      if (sx > W) break;
      for (let wy = startY; ; wy += spacingWorld) {
        const sy = worldToScreen(0, wy).y;
        if (sy > H) break;
        c.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
    // origin crosshair
    const o = worldToScreen(0, 0);
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      c.strokeStyle = "rgba(52,210,255,0.35)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(o.x - 8, o.y); c.lineTo(o.x + 8, o.y);
      c.moveTo(o.x, o.y - 8); c.lineTo(o.x, o.y + 8);
      c.stroke();
    }
    c.restore();
  }

  let renderPending = false;
  function render() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(doRender);
  }
  function renderNow() { doRender(); }

  function doRender() {
    renderPending = false;
    const W = cssW(), H = cssH();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, W, H);

    drawGrid(ctx);

    // Onion skin (only when not playing)
    if (state.onion && !state.playing) {
      for (let d = state.onionDepth; d >= 1; d--) {
        const aBack = state.current - d, aFwd = state.current + d;
        const alpha = 0.32 / d;
        if (aBack >= 0) for (const s of state.frames[aBack].strokes) drawStroke(ctx, s, alpha, "#ff5b6e");
        if (aFwd < state.frames.length) for (const s of state.frames[aFwd].strokes) drawStroke(ctx, s, alpha, "#5b9bff");
      }
    }

    for (const s of frame().strokes) drawStroke(ctx, s, 1);
    if (drawing) drawStroke(ctx, drawing, 0.9);

    renderMinimap();
  }

  // ---- Minimap ----
  // The displayed region is the union of the current viewport and the frame's
  // content, padded — so you always see both "where you are" and "what you drew".
  let miniXf = null;
  function minimapRegion() {
    const W = cssW(), H = cssH();
    const tl = screenToWorld(0, 0), br = screenToWorld(W, H);
    let minX = Math.min(tl.x, br.x), maxX = Math.max(tl.x, br.x);
    let minY = Math.min(tl.y, br.y), maxY = Math.max(tl.y, br.y);
    const b = contentBounds(frame().strokes);
    if (b) {
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    const padX = (maxX - minX) * 0.08 || 10, padY = (maxY - minY) * 0.08 || 10;
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  }

  function renderMinimap() {
    const mc = $("minimapCanvas");
    if (!mc || !state.minimap) return;
    const c = mc.getContext("2d");
    const cw = mc.width, ch = mc.height;
    const reg = minimapRegion();
    const rw = Math.max(1e-6, reg.maxX - reg.minX), rh = Math.max(1e-6, reg.maxY - reg.minY);
    const s = Math.min(cw / rw, ch / rh);
    const ox = (cw - rw * s) / 2, oy = (ch - rh * s) / 2;
    miniXf = { s, ox, oy, reg };
    const P = (wx, wy) => ({ x: (wx - reg.minX) * s + ox, y: (wy - reg.minY) * s + oy });

    c.fillStyle = state.bg;
    c.fillRect(0, 0, cw, ch);
    c.lineJoin = "round"; c.lineCap = "round";
    for (const st of frame().strokes) {
      c.save();
      c.globalAlpha = st.alpha == null ? 1 : st.alpha;
      c.strokeStyle = st.color; c.fillStyle = st.color;
      c.lineWidth = Math.max(0.5, st.width * s);
      const pts = st.points;
      if (st.type === "rect") {
        const a = P(pts[0].x, pts[0].y), b = P(pts[1].x, pts[1].y);
        c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (st.type === "ellipse") {
        const a = P(pts[0].x, pts[0].y), b = P(pts[1].x, pts[1].y);
        c.beginPath();
        c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        c.stroke();
      } else {
        c.beginPath();
        const p0 = P(pts[0].x, pts[0].y); c.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) { const p = P(pts[i].x, pts[i].y); c.lineTo(p.x, p.y); }
        c.stroke();
      }
      c.restore();
    }

    // viewport rectangle
    const W = cssW(), H = cssH();
    const vtl = P(screenToWorld(0, 0).x, screenToWorld(0, 0).y);
    const vbr = P(screenToWorld(W, H).x, screenToWorld(W, H).y);
    c.strokeStyle = "rgba(52,210,255,0.9)";
    c.lineWidth = 1.5;
    c.strokeRect(Math.min(vtl.x, vbr.x), Math.min(vtl.y, vbr.y), Math.abs(vbr.x - vtl.x), Math.abs(vbr.y - vtl.y));
    c.fillStyle = "rgba(52,210,255,0.12)";
    c.fillRect(Math.min(vtl.x, vbr.x), Math.min(vtl.y, vbr.y), Math.abs(vbr.x - vtl.x), Math.abs(vbr.y - vtl.y));
  }

  function centerOn(wx, wy) {
    state.cam.x = wx - cssW() / (2 * state.scale);
    state.cam.y = wy - cssH() / (2 * state.scale);
    render();
    scheduleSave();
  }

  // Convert a click on the minimap canvas (CSS pixels) to a world point and
  // recenter the camera there.
  function minimapNavigate(clientX, clientY) {
    const mc = $("minimapCanvas");
    if (!miniXf) renderMinimap();
    const rect = mc.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * mc.width;
    const py = ((clientY - rect.top) / rect.height) * mc.height;
    const wx = (px - miniXf.ox) / miniXf.s + miniXf.reg.minX;
    const wy = (py - miniXf.oy) / miniXf.s + miniXf.reg.minY;
    centerOn(wx, wy);
    return { x: wx, y: wy };
  }

  // ---- Playback ----
  function play() {
    if (state.playing) return;
    if (state.frames.length < 2) { toast("Add more frames to play"); return; }
    state.playing = true;
    state.playDir = 1;
    updatePlayUI();
    const step = () => {
      const last = state.frames.length - 1;
      if (state.pingpong) {
        // bounce between the ends (endpoints not repeated)
        let n = state.current + state.playDir;
        if (n > last) { state.playDir = -1; n = last - 1; }
        else if (n < 0) { state.playDir = 1; n = 1; }
        gotoFrame(Math.max(0, Math.min(last, n)));
      } else if (state.current >= last) {
        if (state.loop) gotoFrame(0);
        else { pause(); return false; }
      } else {
        gotoFrame(state.current + 1);
      }
      return true;
    };
    const holdMs = (i) => (1000 / state.fps) * Math.max(1, (state.frames[i] && state.frames[i].hold) || 1);
    const tick = () => {
      if (!state.playing) return;
      if (step() === false) return;
      playTimer = setTimeout(tick, holdMs(state.current));
    };
    playTimer = setTimeout(tick, holdMs(state.current));
  }
  function pause() {
    state.playing = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    updatePlayUI();
    render();
  }
  function togglePlay() { state.playing ? pause() : play(); }

  // ---- Persistence ----
  function serialize() {
    return {
      v: 2,
      cam: { x: state.cam.x, y: state.cam.y },
      scale: state.scale,
      current: state.current,
      frames: state.frames.map((f) => ({
        hold: f.hold || 1,
        strokes: f.strokes.map((s) => ({ type: s.type, color: s.color, width: s.width, alpha: s.alpha, points: s.points })),
      })),
      settings: {
        tool: state.tool, color: state.color, brushSize: state.brushSize, opacity: state.opacity,
        zoomDependent: state.zoomDependent, smooth: state.smooth, grid: state.grid, minimap: state.minimap, bg: state.bg,
        fps: state.fps, onion: state.onion, onionDepth: state.onionDepth, loop: state.loop, pingpong: state.pingpong,
      },
    };
  }

  function applyData(data) {
    if (!data || !Array.isArray(data.frames) || data.frames.length === 0) return false;
    state.frames = data.frames.map((f) => makeFrame((f.strokes || []).map((s) => ({
      id: uid(), type: s.type || "path", color: s.color || "#fff",
      width: s.width || 1, alpha: typeof s.alpha === "number" ? s.alpha : 1,
      points: (s.points || []).map((p) => ({ x: p.x, y: p.y })),
    })), f.hold || 1));
    state.current = Math.max(0, Math.min(state.frames.length - 1, data.current || 0));
    if (data.cam) { state.cam.x = data.cam.x; state.cam.y = data.cam.y; }
    if (typeof data.scale === "number") state.scale = clampScale(data.scale);
    const s = data.settings || {};
    if (s.tool) state.tool = s.tool;
    if (s.color) state.color = s.color;
    if (typeof s.brushSize === "number") state.brushSize = s.brushSize;
    if (typeof s.opacity === "number") state.opacity = s.opacity;
    if (typeof s.zoomDependent === "boolean") state.zoomDependent = s.zoomDependent;
    if (typeof s.smooth === "boolean") state.smooth = s.smooth;
    if (typeof s.grid === "boolean") state.grid = s.grid;
    if (typeof s.minimap === "boolean") state.minimap = s.minimap;
    if (typeof s.bg === "string") state.bg = s.bg;
    if (typeof s.fps === "number") state.fps = s.fps;
    if (typeof s.onion === "boolean") state.onion = s.onion;
    if (typeof s.onionDepth === "number") state.onionDepth = s.onionDepth;
    if (typeof s.loop === "boolean") state.loop = s.loop;
    if (typeof s.pingpong === "boolean") state.pingpong = s.pingpong;
    undoStack.length = 0; redoStack.length = 0;
    syncControls();
    render();
    updateFrameUI();
    updateZoomLabel();
    return true;
  }

  function save() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(serialize()));
      return true;
    } catch (e) { return false; }
  }
  function load() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return false;
      return applyData(JSON.parse(raw));
    } catch (e) { return false; }
  }
  function clearStorage() { try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {} }

  function scheduleSave() {
    if (suppressSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, CONFIG.AUTOSAVE_MS);
  }
  function afterChange() {
    render();
    updateFrameUI();
    updateHistoryUI();
    scheduleSave();
  }

  function exportProject() { return JSON.stringify(serialize(), null, 2); }
  function importProject(json) {
    try { return applyData(typeof json === "string" ? JSON.parse(json) : json); }
    catch (e) { return false; }
  }

  // ---- UI wiring ----
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    canvas.classList.toggle("panning", t === "pan");
    scheduleSave();
  }
  function setColor(c) {
    c = typeof c === "string" ? c.toLowerCase() : c;
    if (c !== state.color) state.prevColor = state.color;
    state.color = c;
    $("color").value = c;
    document.querySelectorAll(".pcolor").forEach((b) => b.classList.toggle("active", b.dataset.color === c));
    scheduleSave();
  }
  function setSize(n) {
    state.brushSize = Math.max(1, Math.min(200, n));
    $("size").value = state.brushSize;
    $("sizeOut").textContent = state.brushSize;
    scheduleSave();
  }
  function setZoomDependent(v) { state.zoomDependent = !!v; $("zoomDependent").checked = state.zoomDependent; scheduleSave(); }
  function setOpacity(pct) {
    state.opacity = Math.max(0.05, Math.min(1, pct / 100));
    $("opacity").value = Math.round(state.opacity * 100);
    $("opacityOut").textContent = Math.round(state.opacity * 100) + "%";
    scheduleSave();
  }
  function setBg(c) { state.bg = c; $("bg").value = c; render(); scheduleSave(); }
  function setMinimap(v) {
    state.minimap = !!v;
    $("minimap").classList.toggle("collapsed", !state.minimap);
    $("minimapToggle").textContent = state.minimap ? "hide" : "show";
    if (state.minimap) renderMinimap();
    scheduleSave();
  }
  function setFps(n) { state.fps = Math.max(1, Math.min(60, n)); $("fps").value = state.fps; $("fpsOut").textContent = state.fps; scheduleSave(); }
  function setOnion(v) { state.onion = !!v; $("onion").checked = state.onion; render(); scheduleSave(); }
  function setPingpong(v) { state.pingpong = !!v; $("pingpong").checked = state.pingpong; scheduleSave(); }

  function updateZoomLabel() {
    const pct = state.scale * 100;
    let txt;
    if (pct >= 1000) txt = (state.scale).toFixed(0) + "×";
    else if (pct >= 10) txt = pct.toFixed(0) + "%";
    else txt = pct.toFixed(1) + "%";
    $("zoomLabel").textContent = txt;
  }
  function updateHistoryUI() {
    $("undo").disabled = undoStack.length === 0;
    $("redo").disabled = redoStack.length === 0;
  }
  function updatePlayUI() {
    const b = $("playPause");
    b.classList.toggle("playing", state.playing);
    b.textContent = state.playing ? "⏸ Pause" : "▶ Play";
  }

  function updateFrameUI() {
    $("frameCounter").textContent = `${state.current + 1} / ${state.frames.length}`;
    $("holdOut").textContent = "×" + getFrameHold(state.current);
    renderThumbs();
  }

  function renderThumbs() {
    const host = $("thumbs");
    // Re-use existing children where possible to keep it light.
    host.innerHTML = "";
    state.frames.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "thumb" + (i === state.current ? " active" : "");
      row.dataset.index = i;
      const num = document.createElement("span");
      num.className = "tnum";
      num.textContent = i + 1;
      const tc = document.createElement("canvas");
      tc.width = 128; tc.height = 80;
      drawThumb(tc, f);
      const drag = document.createElement("span");
      drag.className = "tdrag";
      drag.textContent = "⋮⋮";
      drag.draggable = true;
      drag.dataset.index = i;
      row.appendChild(num);
      row.appendChild(tc);
      if ((f.hold || 1) > 1) {
        const badge = document.createElement("span");
        badge.className = "thold";
        badge.textContent = "×" + f.hold;
        row.appendChild(badge);
      }
      row.appendChild(drag);
      row.addEventListener("click", () => gotoFrame(i));
      host.appendChild(row);
    });
    wireThumbDnD();
  }

  function drawThumb(tc, f) {
    const c = tc.getContext("2d");
    c.fillStyle = "#0d0f15";
    c.fillRect(0, 0, tc.width, tc.height);
    const b = contentBounds(f.strokes);
    if (!b) return;
    const pad = 6;
    const bw = Math.max(1e-6, b.maxX - b.minX), bh = Math.max(1e-6, b.maxY - b.minY);
    const s = Math.min((tc.width - pad * 2) / bw, (tc.height - pad * 2) / bh);
    const ox = pad - b.minX * s + ((tc.width - pad * 2) - bw * s) / 2;
    const oy = pad - b.minY * s + ((tc.height - pad * 2) - bh * s) / 2;
    c.lineJoin = "round"; c.lineCap = "round";
    for (const st of f.strokes) {
      c.strokeStyle = st.color; c.fillStyle = st.color;
      c.lineWidth = Math.max(0.5, st.width * s);
      const P = (p) => ({ x: p.x * s + ox, y: p.y * s + oy });
      const pts = st.points;
      if (st.type === "rect") {
        const a = P(pts[0]), d = P(pts[1]);
        c.strokeRect(Math.min(a.x, d.x), Math.min(a.y, d.y), Math.abs(d.x - a.x), Math.abs(d.y - a.y));
      } else if (st.type === "ellipse") {
        const a = P(pts[0]), d = P(pts[1]);
        c.beginPath();
        c.ellipse((a.x + d.x) / 2, (a.y + d.y) / 2, Math.abs(d.x - a.x) / 2, Math.abs(d.y - a.y) / 2, 0, 0, Math.PI * 2);
        c.stroke();
      } else {
        c.beginPath();
        const p0 = P(pts[0]); c.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) { const p = P(pts[i]); c.lineTo(p.x, p.y); }
        c.stroke();
      }
    }
  }

  let dragFrom = null;
  function wireThumbDnD() {
    document.querySelectorAll(".tdrag").forEach((d) => {
      d.addEventListener("dragstart", (e) => { dragFrom = +d.dataset.index; e.dataTransfer.effectAllowed = "move"; });
    });
    document.querySelectorAll(".thumb").forEach((row) => {
      row.addEventListener("dragover", (e) => { e.preventDefault(); });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const to = +row.dataset.index;
        if (dragFrom != null && dragFrom !== to) moveFrame(dragFrom, to);
        dragFrom = null;
      });
    });
  }

  function syncControls() {
    $("color").value = state.color;
    $("bg").value = state.bg;
    $("size").value = state.brushSize; $("sizeOut").textContent = state.brushSize;
    $("opacity").value = Math.round(state.opacity * 100); $("opacityOut").textContent = Math.round(state.opacity * 100) + "%";
    $("zoomDependent").checked = state.zoomDependent;
    $("smooth").checked = state.smooth;
    $("fps").value = state.fps; $("fpsOut").textContent = state.fps;
    $("onion").checked = state.onion;
    $("onionDepth").value = state.onionDepth; $("onionDepthOut").textContent = state.onionDepth;
    $("loop").checked = state.loop;
    $("pingpong").checked = state.pingpong;
    $("minimap").classList.toggle("collapsed", !state.minimap);
    $("minimapToggle").textContent = state.minimap ? "hide" : "show";
    setTool(state.tool);
    document.querySelectorAll(".pcolor").forEach((b) => b.classList.toggle("active", b.dataset.color === state.color));
    updatePlayUI();
    updateHistoryUI();
  }

  // ---- Toast ----
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("show"); }, 1300);
  }

  // ---- Pointer input ----
  function evtScreen(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function isPanGesture(e) {
    return state.tool === "pan" || spaceHeld || e.button === 1;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (state.playing) pause();
    canvas.setPointerCapture(e.pointerId);
    const sp = evtScreen(e);
    if (isPanGesture(e)) {
      panState = { lastScreen: sp };
      canvas.classList.add("active");
      return;
    }
    const w = screenToWorld(sp.x, sp.y);
    if (state.tool === "eyedropper") {
      const c = pickColorAt(w);
      toast(c ? "Picked " + c : "Nothing to pick");
      return;
    }
    if (state.tool === "eraser") {
      eraseAt(w);
      drawing = { _erasing: true };
      return;
    }
    beginStroke(w);
  });

  canvas.addEventListener("pointermove", (e) => {
    const sp = evtScreen(e);
    if (panState) {
      panBy(sp.x - panState.lastScreen.x, sp.y - panState.lastScreen.y);
      panState.lastScreen = sp;
      return;
    }
    if (!drawing) return;
    const w = screenToWorld(sp.x, sp.y);
    if (drawing._erasing) { eraseAt(w); return; }
    extendStroke(w);
  });

  function finishPointer(e) {
    if (panState) {
      panState = null;
      canvas.classList.remove("active");
      return;
    }
    if (drawing && drawing._erasing) { drawing = null; return; }
    if (drawing) endStroke();
  }
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const sp = evtScreen(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(sp.x, sp.y, factor);
  }, { passive: false });

  // ---- Keyboard ----
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (save()) toast("Saved"); return; }
    if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); copyFrame(); return; }
    if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); pasteFrame(); return; }
    if (e.key === " ") { spaceHeld = true; canvas.classList.add("panning"); return; }

    switch (e.key.toLowerCase()) {
      case "p": setTool("pen"); break;
      case "l": setTool("line"); break;
      case "r": setTool("rect"); break;
      case "o": setTool("ellipse"); break;
      case "e": setTool("eraser"); break;
      case "i": setTool("eyedropper"); break;
      case "h": setTool("pan"); break;
      case "g": state.grid = !state.grid; render(); scheduleSave(); break;
      case "m": setMinimap(!state.minimap); break;
      case "0": resetView(); break;
      case "f": fitView(); break;
      case "[": setSize(state.brushSize - 1); break;
      case "]": setSize(state.brushSize + 1); break;
      case "c": $("color").focus(); break;
      case "x": setColor(state.prevColor); break;
      case "n": addFrame(); break;
      case "d": dupFrame(); break;
      case ",": prevFrame(); break;
      case ".": nextFrame(); break;
      case "enter": togglePlay(); break;
      default: return;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceHeld = false;
      if (state.tool !== "pan") canvas.classList.remove("panning");
    }
  });

  // ---- Button wiring ----
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("color").addEventListener("input", (e) => setColor(e.target.value));
  $("bg").addEventListener("input", (e) => setBg(e.target.value));
  $("size").addEventListener("input", (e) => setSize(+e.target.value));
  $("opacity").addEventListener("input", (e) => setOpacity(+e.target.value));
  $("zoomDependent").addEventListener("change", (e) => setZoomDependent(e.target.checked));
  $("smooth").addEventListener("change", (e) => { state.smooth = e.target.checked; render(); scheduleSave(); });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("clearFrame").addEventListener("click", clearFrame);
  $("resetView").addEventListener("click", resetView);
  $("fitView").addEventListener("click", () => fitView());
  $("save").addEventListener("click", () => { if (save()) toast("Saved"); });
  $("exportJson").addEventListener("click", downloadJson);
  $("importJson").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", onImportFile);
  $("exportPng").addEventListener("click", downloadPng);
  $("exportGif").addEventListener("click", onExportGif);

  $("firstFrame").addEventListener("click", () => gotoFrame(0));
  $("prevFrame").addEventListener("click", prevFrame);
  $("nextFrame").addEventListener("click", nextFrame);
  $("lastFrame").addEventListener("click", () => gotoFrame(state.frames.length - 1));
  $("playPause").addEventListener("click", togglePlay);
  $("addFrame").addEventListener("click", addFrame);
  $("dupFrame").addEventListener("click", dupFrame);
  $("delFrame").addEventListener("click", delFrame);
  $("copyFrame").addEventListener("click", copyFrame);
  $("pasteFrame").addEventListener("click", pasteFrame);
  $("reverseFrames").addEventListener("click", reverseFrames);
  $("holdMinus").addEventListener("click", () => setFrameHold(state.current, getFrameHold(state.current) - 1));
  $("holdPlus").addEventListener("click", () => setFrameHold(state.current, getFrameHold(state.current) + 1));
  $("fps").addEventListener("input", (e) => setFps(+e.target.value));
  $("onion").addEventListener("change", (e) => setOnion(e.target.checked));
  $("onionDepth").addEventListener("input", (e) => { state.onionDepth = +e.target.value; $("onionDepthOut").textContent = state.onionDepth; render(); scheduleSave(); });
  $("loop").addEventListener("change", (e) => { state.loop = e.target.checked; scheduleSave(); });
  $("pingpong").addEventListener("change", (e) => setPingpong(e.target.checked));
  $("helpToggle").addEventListener("click", () => { const b = $("helpBody"); b.hidden = !b.hidden; });

  // minimap navigation (click or drag to jump the camera)
  let miniDragging = false;
  const mcEl = $("minimapCanvas");
  mcEl.addEventListener("pointerdown", (e) => {
    miniDragging = true;
    mcEl.setPointerCapture(e.pointerId);
    minimapNavigate(e.clientX, e.clientY);
  });
  mcEl.addEventListener("pointermove", (e) => { if (miniDragging) minimapNavigate(e.clientX, e.clientY); });
  mcEl.addEventListener("pointerup", () => { miniDragging = false; });
  $("minimapToggle").addEventListener("click", () => setMinimap(!state.minimap));

  // palette
  (function buildPalette() {
    const host = $("palette");
    CONFIG.PALETTE.forEach((col) => {
      const b = document.createElement("button");
      b.className = "pcolor";
      b.style.background = col;
      b.dataset.color = col;
      b.title = col;
      b.addEventListener("click", () => setColor(col));
      host.appendChild(b);
    });
  })();

  // ---- Export helpers ----
  function triggerDownload(blobOrUrl, filename) {
    const a = document.createElement("a");
    a.href = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof blobOrUrl !== "string") setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function downloadJson() {
    triggerDownload(new Blob([exportProject()], { type: "application/json" }), "infinitedraw.json");
    toast("Exported JSON");
  }
  function onImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => { if (importProject(r.result)) toast("Imported"); else toast("Import failed"); };
    r.readAsText(file);
    e.target.value = "";
  }
  function downloadPng() {
    renderNow();
    canvas.toBlob((blob) => { triggerDownload(blob, "infinitedraw.png"); toast("Exported PNG"); });
  }
  // Render any frame's strokes to an offscreen canvas using the CURRENT camera.
  function renderFrameToCanvas(frameIndex, w, h) {
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const c = off.getContext("2d");
    c.fillStyle = state.bg;
    c.fillRect(0, 0, w, h);
    const saved = ctxProxy(c);
    for (const s of state.frames[frameIndex].strokes) saved.drawStroke(s);
    return off;
  }
  // small proxy so drawStroke can target an arbitrary context at dpr=1
  function ctxProxy(c) {
    return {
      drawStroke(s) {
        c.save();
        c.globalAlpha = s.alpha == null ? 1 : s.alpha;
        c.strokeStyle = s.color; c.fillStyle = s.color;
        c.lineWidth = strokeScreenWidth(s);
        c.lineJoin = "round"; c.lineCap = "round";
        const pts = s.points;
        const P = (p) => worldToScreen(p.x, p.y);
        if (s.type === "rect") {
          const a = P(pts[0]), b = P(pts[1]);
          c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        } else if (s.type === "ellipse") {
          const a = P(pts[0]), b = P(pts[1]);
          c.beginPath();
          c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
          c.stroke();
        } else {
          const scr = pts.map(P);
          c.beginPath();
          c.moveTo(scr[0].x, scr[0].y);
          if (state.smooth && s.type === "path" && scr.length > 2) {
            for (let i = 1; i < scr.length - 1; i++) {
              const mid = { x: (scr[i].x + scr[i + 1].x) / 2, y: (scr[i].y + scr[i + 1].y) / 2 };
              c.quadraticCurveTo(scr[i].x, scr[i].y, mid.x, mid.y);
            }
            const last = scr[scr.length - 1]; c.lineTo(last.x, last.y);
          } else {
            for (let i = 1; i < scr.length; i++) c.lineTo(scr[i].x, scr[i].y);
            if (scr.length === 1) c.lineTo(scr[0].x + 0.01, scr[0].y + 0.01);
          }
          c.stroke();
        }
        c.restore();
      },
    };
  }
  function onExportGif() {
    if (typeof window.encodeGIF !== "function") { toast("GIF encoder not loaded"); return; }
    const W = Math.min(640, cssW()), H = Math.min(400, cssH());
    toast("Rendering GIF…");
    const frames = state.frames.map((_, i) => renderFrameToCanvas(i, W, H));
    try {
      const bytes = window.encodeGIF(frames, frameDelaysCs(), W, H);
      triggerDownload(new Blob([bytes], { type: "image/gif" }), "infinitedraw.gif");
      toast("Exported GIF");
    } catch (err) {
      toast("GIF export failed");
      console.error(err);
    }
  }

  // ---- Pixel inspection (for tests) ----
  function getCanvasPixel(sx, sy) {
    const d = ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }

  // ---- Boot ----
  function boot() {
    window.addEventListener("resize", resize);
    resize();
    if (!load()) {
      resetView();
    }
    syncControls();
    render();
    updateFrameUI();
    updateZoomLabel();
    updateHistoryUI();
    document.body.dataset.ready = "1";
  }

  // ---- Public API (testing + integrations) ----
  window.App = {
    state,
    CONFIG,
    // camera
    worldToScreen, screenToWorld, zoomAt, setZoom, panBy, resetView, fitView,
    getZoom: () => state.scale,
    getCam: () => ({ x: state.cam.x, y: state.cam.y }),
    // drawing
    setTool, getTool: () => state.tool,
    setColor, getColor: () => state.color,
    setBg, getBg: () => state.bg,
    setSize, getSize: () => state.brushSize,
    setOpacity, getOpacity: () => state.opacity,
    setZoomDependent, isZoomDependent: () => state.zoomDependent,
    strokeWorldWidth, strokeScreenWidth,
    beginStroke, extendStroke, endStroke, addStroke, eraseAt, pickColorAt,
    // convenience: draw a full stroke through a list of world points
    drawPath(points, opts) {
      opts = opts || {};
      const prevTool = state.tool;
      if (opts.tool) state.tool = opts.tool;
      beginStroke(points[0], opts);
      for (let i = 1; i < points.length; i++) extendStroke(points[i]);
      const s = endStroke();
      state.tool = prevTool;
      return s;
    },
    // frames
    addFrame, dupFrame, delFrame, moveFrame, gotoFrame, nextFrame, prevFrame, clearFrame,
    reverseFrames, copyFrame, pasteFrame,
    setFrameHold, getFrameHold, frameDelaysCs,
    setSmooth: (v) => { state.smooth = !!v; $("smooth").checked = state.smooth; render(); },
    frameCount: () => state.frames.length,
    currentFrame: () => state.current,
    currentStrokes: () => frame().strokes,
    // playback
    play, pause, togglePlay, isPlaying: () => state.playing, setFps, setOnion, setPingpong,
    setOnionDepth: (n) => { state.onionDepth = n; $("onionDepthOut").textContent = n; $("onionDepth").value = n; render(); },
    setGrid: (v) => { state.grid = !!v; render(); },
    setMinimap, minimapRegion, minimapNavigate, centerOn,
    // history
    undo, redo, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
    historyDepth: () => ({ undo: undoStack.length, redo: redoStack.length }),
    // persistence
    save, load, clearStorage, exportProject, importProject, serialize,
    // render / inspect
    render, renderNow, getCanvasPixel,
    contentBounds: () => contentBounds(frame().strokes),
    canvasSize: () => ({ w: cssW(), h: cssH(), dpr }),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
