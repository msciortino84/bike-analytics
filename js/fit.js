// Parser FIT minimale: estrae i messaggi "record" (20) e "session" (18).
const FIT_EPOCH = 631065600; // 1989-12-31 in secondi Unix

export function parseFit(buffer) {
  const dv = new DataView(buffer);
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error('File FIT non valido');

  const defs = {};
  const records = [];
  let session = null;
  let pos = headerSize;
  const end = headerSize + dataSize;
  let lastTs = 0;

  while (pos < end) {
    const hdr = dv.getUint8(pos++);
    if (hdr & 0x80) { // compressed timestamp header
      const local = (hdr >> 5) & 0x03;
      const offset = hdr & 0x1f;
      const ts = (lastTs & ~0x1f) + offset + (offset < (lastTs & 0x1f) ? 0x20 : 0);
      lastTs = ts;
      const msg = readData(dv, pos, defs[local]);
      pos += defs[local].size;
      msg.values[253] ??= ts;
      handle(msg);
      continue;
    }
    const local = hdr & 0x0f;
    if (hdr & 0x40) { // definition
      const devFlag = hdr & 0x20;
      const little = dv.getUint8(pos + 1) === 0;
      const global = dv.getUint16(pos + 2, little);
      const n = dv.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      let size = 0;
      for (let i = 0; i < n; i++) {
        const f = { num: dv.getUint8(pos), size: dv.getUint8(pos + 1), type: dv.getUint8(pos + 2) & 0x1f };
        fields.push(f); size += f.size; pos += 3;
      }
      if (devFlag) {
        const nd = dv.getUint8(pos++);
        for (let i = 0; i < nd; i++) { size += dv.getUint8(pos + 1); pos += 3; }
      }
      defs[local] = { global, little, fields, size };
    } else {
      const def = defs[local];
      if (!def) throw new Error('FIT corrotto');
      const msg = readData(dv, pos, def);
      pos += def.size;
      if (msg.values[253] != null) lastTs = msg.values[253];
      handle(msg);
    }
  }

  function handle(msg) {
    const v = msg.values;
    if (msg.global === 20) {
      records.push({
        t: v[253] != null ? (v[253] + FIT_EPOCH) * 1000 : null,
        hr: v[3] ?? null,
        lat: v[0] != null ? v[0] * (180 / 2 ** 31) : null, // semicerchi → gradi
        lng: v[1] != null ? v[1] * (180 / 2 ** 31) : null,
        cad: v[4] ?? null,
        power: v[7] ?? null,
        speed: v[73] != null ? v[73] / 1000 : v[6] != null ? v[6] / 1000 : null, // m/s
        dist: v[5] != null ? v[5] / 100 : null, // m
        alt: v[78] != null ? v[78] / 5 - 500 : v[2] != null ? v[2] / 5 - 500 : null,
      });
    } else if (msg.global === 18) {
      session = {
        start: v[2] != null ? (v[2] + FIT_EPOCH) * 1000 : null,
        sport: v[5],
        movingTime: v[59] != null ? v[59] / 1000 : v[8] != null ? v[8] / 1000 : null,
        distance: v[9] != null ? v[9] / 100 : null,
        ascent: v[22] ?? null,
      };
    }
  }

  return { records, session };
}

function readData(dv, pos, def) {
  const values = {};
  for (const f of def.fields) {
    values[f.num] = readVal(dv, pos, f, def.little);
    pos += f.size;
  }
  return { global: def.global, values };
}

function readVal(dv, p, f, le) {
  const invalid = (x, inv) => (x === inv ? undefined : x);
  switch (f.type) {
    case 0: case 2: case 10: case 13:
      return f.size === 1 ? invalid(dv.getUint8(p), f.type === 10 ? 0 : 0xff) : undefined;
    case 1: return f.size === 1 ? invalid(dv.getInt8(p), 0x7f) : undefined;
    case 3: return f.size >= 2 ? invalid(dv.getInt16(p, le), 0x7fff) : undefined;
    case 4: case 11: return f.size >= 2 ? invalid(dv.getUint16(p, le), f.type === 11 ? 0 : 0xffff) : undefined;
    case 5: return f.size >= 4 ? invalid(dv.getInt32(p, le), 0x7fffffff) : undefined;
    case 6: case 12: return f.size >= 4 ? invalid(dv.getUint32(p, le), f.type === 12 ? 0 : 0xffffffff) : undefined;
    case 8: return f.size >= 4 ? dv.getFloat32(p, le) : undefined;
    case 9: return f.size >= 8 ? dv.getFloat64(p, le) : undefined;
    default: return undefined;
  }
}
