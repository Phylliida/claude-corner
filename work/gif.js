/* Minimal animated-GIF encoder (GIF89a) with LZW compression.
 *
 * window.encodeGIF(frames, delayCs, width, height) -> Uint8Array
 *   frames  : array of <canvas> (or anything with getContext('2d')), each WxH
 *   delayCs : delay in centiseconds (1/100 s) — a single number applied to every
 *             frame, or an array of per-frame delays (one per frame).
 *   width   : output width  (default: first frame's width)
 *   height  : output height (default: first frame's height)
 *
 * Each frame is quantised to a shared 256-colour palette built with a simple
 * median-cut over the colours actually used across all frames. Good enough for
 * line art on a flat background; not a general-purpose photographic quantiser.
 */
(function () {
  "use strict";

  function collectPixels(frames, w, h) {
    const all = [];
    for (const cv of frames) {
      const c = cv.getContext("2d");
      const data = c.getImageData(0, 0, w, h).data;
      all.push(data);
    }
    return all;
  }

  // Median-cut quantisation -> up to 256 representative colours.
  function quantize(pixelArrays, w, h, maxColors) {
    const seen = new Map(); // packed rgb -> count
    for (const data of pixelArrays) {
      for (let i = 0; i < data.length; i += 4) {
        // round to 5 bits/channel to keep the histogram small
        const r = data[i] & 0xf8, g = data[i + 1] & 0xf8, b = data[i + 2] & 0xf8;
        const key = (r << 16) | (g << 8) | b;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    let boxes = [Array.from(seen.keys())];
    const unpack = (k) => [(k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff];

    while (boxes.length < maxColors) {
      // find the box with the largest colour range to split
      let bi = -1, bestRange = -1, bestChan = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.length < 2) continue;
        let mn = [255, 255, 255], mx = [0, 0, 0];
        for (const k of box) {
          const c = unpack(k);
          for (let ch = 0; ch < 3; ch++) { if (c[ch] < mn[ch]) mn[ch] = c[ch]; if (c[ch] > mx[ch]) mx[ch] = c[ch]; }
        }
        for (let ch = 0; ch < 3; ch++) {
          const range = mx[ch] - mn[ch];
          if (range > bestRange) { bestRange = range; bi = i; bestChan = ch; }
        }
      }
      if (bi < 0 || bestRange <= 0) break;
      const box = boxes[bi];
      box.sort((a, b) => unpack(a)[bestChan] - unpack(b)[bestChan]);
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }

    // average each box -> palette entry
    const palette = boxes.map((box) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const k of box) { const w = seen.get(k) || 1; const c = unpack(k); r += c[0] * w; g += c[1] * w; b += c[2] * w; n += w; }
      n = n || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
    while (palette.length < 2) palette.push([0, 0, 0]);
    return palette;
  }

  function nearestIndex(palette, r, g, b) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // LZW encode one frame's index buffer.
  function lzwEncode(minCodeSize, indices) {
    const out = [];
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict = new Map();
    const resetDict = () => {
      dict = new Map();
      for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    };
    resetDict();
    let next = eoiCode + 1;

    // bit writer
    let cur = 0, curBits = 0;
    const bytes = [];
    const writeCode = (code) => {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { bytes.push(cur & 0xff); cur >>= 8; curBits -= 8; }
    };

    writeCode(clearCode);
    let prefix = String(indices[0]);
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const combined = prefix + "," + k;
      if (dict.has(combined)) {
        prefix = combined;
      } else {
        writeCode(dict.get(prefix));
        dict.set(combined, next++);
        if (next === (1 << codeSize) + 1 && codeSize < 12) {
          codeSize++;
        }
        if (next > 4095) {
          writeCode(clearCode);
          resetDict();
          next = eoiCode + 1;
          codeSize = minCodeSize + 1;
        }
        prefix = String(k);
      }
    }
    writeCode(dict.get(prefix));
    writeCode(eoiCode);
    if (curBits > 0) bytes.push(cur & 0xff);

    // chunk into sub-blocks of <=255 bytes
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0); // block terminator
    return out;
  }

  function encodeGIF(frames, delayCs, width, height) {
    const w = width || frames[0].width;
    const h = height || frames[0].height;
    const delayAt = (i) => {
      const d = Array.isArray(delayCs) ? (delayCs[i] != null ? delayCs[i] : delayCs[delayCs.length - 1]) : delayCs;
      return Math.max(2, d | 0);
    };

    const pixelArrays = collectPixels(frames, w, h);
    const palette = quantize(pixelArrays, w, h, 256);
    // pad palette to a power of two
    let palSize = 2;
    while (palSize < palette.length) palSize <<= 1;
    const colorBits = Math.max(1, Math.log2(palSize));
    while (palette.length < palSize) palette.push([0, 0, 0]);

    const bytes = [];
    const push = (...b) => { for (const x of b) bytes.push(x & 0xff); };
    const pushStr = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
    const word = (n) => { bytes.push(n & 0xff, (n >> 8) & 0xff); };

    // Header
    pushStr("GIF89a");
    // Logical screen descriptor
    word(w); word(h);
    const gctFlag = 0x80 | ((colorBits - 1) << 4) | (colorBits - 1);
    push(gctFlag, 0, 0);
    // Global color table
    for (const c of palette) push(c[0], c[1], c[2]);
    // Netscape looping extension
    push(0x21, 0xff, 0x0b);
    pushStr("NETSCAPE2.0");
    push(0x03, 0x01, 0x00, 0x00, 0x00); // loop forever

    const minCodeSize = Math.max(2, colorBits);

    for (let fi = 0; fi < pixelArrays.length; fi++) {
      const data = pixelArrays[fi];
      // Graphic control extension (delay)
      push(0x21, 0xf9, 0x04, 0x00);
      word(delayAt(fi));
      push(0, 0x00);
      // Image descriptor
      push(0x2c);
      word(0); word(0); word(w); word(h);
      push(0x00); // no local color table
      // index buffer
      const indices = new Array(w * h);
      for (let p = 0, j = 0; p < data.length; p += 4, j++) {
        indices[j] = nearestIndex(palette, data[p], data[p + 1], data[p + 2]);
      }
      push(minCodeSize);
      const enc = lzwEncode(minCodeSize, indices);
      for (const b of enc) bytes.push(b & 0xff);
    }

    push(0x3b); // trailer
    return new Uint8Array(bytes);
  }

  window.encodeGIF = encodeGIF;
})();
