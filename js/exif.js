// JPEG suratdan EXIF ma'lumotini o'qiydi: olingan vaqt va GPS joylashuv.
// Hammasi brauzerda bajariladi; faqat natija (sana va koordinata) serverga yuboriladi.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export async function readExif(file) {
  try {
    if (!/\.jpe?g$/i.test(file.name) && file.type !== 'image/jpeg') return {};
    const v = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return {};
    let p = 2;
    while (p + 4 < v.byteLength) {
      if (v.getUint8(p) !== 0xff) break;
      const marker = v.getUint8(p + 1);
      if (marker === 0xda) break;                       // rasm ma'lumoti boshlandi, EXIF topilmadi
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966) return parseTiff(v, p + 10);   // "Exif"
      p += 2 + len;
    }
  } catch { /* buzilgan EXIF: e'tiborsiz qoldiramiz */ }
  return {};
}

function parseTiff(v, base) {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o) => v.getUint16(base + o, le);
  const u32 = (o) => v.getUint32(base + o, le);

  const readIfd = (off) => {
    const tags = {};
    const n = u16(off);
    for (let i = 0; i < n && i < 200; i++) {
      const e = off + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return tags;
  };
  const valueAt = (t) => ((TYPE_SIZE[t.type] || 1) * t.count > 4 ? u32(t.at) : t.at);
  const ascii = (t) => {
    const o = valueAt(t);
    let s = '';
    for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(base + o + i));
    return s;
  };
  const rational = (t, i) => {
    const o = valueAt(t) + i * 8;
    const d = u32(o + 4);
    return d ? u32(o) / d : 0;
  };

  const out = {};
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(u32(ifd0[0x8769].at)) : {};

  // Olingan vaqt: "YYYY:MM:DD HH:MM:SS" (kamera mahalliy vaqti)
  const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
  const m = dt && /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(ascii(dt));
  if (m) {
    const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (m[1] > 1990 && ts < Date.now() + 86_400_000) out.takenAt = ts;
  }

  // GPS: daraja, minut, soniya
  const gps = ifd0[0x8825] ? readIfd(u32(ifd0[0x8825].at)) : null;
  if (gps && gps[2] && gps[4] && gps[1] && gps[3]) {
    const deg = (t) => rational(t, 0) + rational(t, 1) / 60 + rational(t, 2) / 3600;
    let lat = deg(gps[2]), lon = deg(gps[4]);
    if (ascii(gps[1]).startsWith('S')) lat = -lat;
    if (ascii(gps[3]).startsWith('W')) lon = -lon;
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) {
      out.lat = +lat.toFixed(6);
      out.lon = +lon.toFixed(6);
    }
  }
  return out;
}
