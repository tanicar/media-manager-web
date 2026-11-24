// How long one play-through of an animation lasts (GIF, animated WebP, APNG), from the frame delays
// stored in the file. Same rules as the phone app (Animation.kt). Null if unknown.

const u8 = (b, i) => b[i];
const frameMs = (ms) => (ms <= 10 ? 100 : ms); // like browsers: tiny delays count as 100 ms
const ascii = (b, at, s) => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

export function durationMs(b) {
  try {
    let ms = 0;
    if (ascii(b, 0, 'GIF8')) ms = gif(b);
    else if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) ms = webp(b);
    else if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG')) ms = apng(b);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function gif(b) {
  let pos = 13;
  const flags = u8(b, 10);
  if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
  const skip = () => {
    while (pos < b.length) {
      const size = b[pos++];
      if (size === 0) return;
      pos += size;
    }
  };
  let total = 0;
  let frames = 0;
  let delay = 0;
  while (pos < b.length) {
    const t = b[pos++];
    if (t === 0x21) {
      const label = b[pos++];
      if (label === 0xf9 && pos + 4 < b.length) delay = (b[pos + 2] | (b[pos + 3] << 8)) * 10;
      skip();
    } else if (t === 0x2c) {
      const f = b[pos + 8];
      pos += 9;
      if (f & 0x80) pos += 3 * (1 << ((f & 7) + 1));
      pos++;
      skip();
      total += frameMs(delay);
      frames++;
      delay = 0;
    } else break;
  }
  return frames > 1 ? total : 0;
}

function webp(b) {
  let pos = 12;
  let total = 0;
  let frames = 0;
  while (pos + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(pos, pos + 4));
    const len = b[pos + 4] | (b[pos + 5] << 8) | (b[pos + 6] << 16) | (b[pos + 7] << 24);
    if (len < 0) break;
    if (type === 'ANMF' && pos + 23 <= b.length) {
      const d = pos + 20;
      total += frameMs(b[d] | (b[d + 1] << 8) | (b[d + 2] << 16));
      frames++;
    }
    pos += 8 + len + (len & 1);
  }
  return frames > 1 ? total : 0;
}

function apng(b) {
  let pos = 8;
  let total = 0;
  let frames = 0;
  while (pos + 8 <= b.length) {
    const len = ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
    const type = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    if (type === 'fcTL' && pos + 32 <= b.length) {
      const d = pos + 28;
      const num = (b[d] << 8) | b[d + 1];
      const den = ((b[d + 2] << 8) | b[d + 3]) || 100;
      total += frameMs((num * 1000) / den);
      frames++;
    }
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return frames > 1 ? total : 0;
}
