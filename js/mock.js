// DEMO REJIMI: haqiqiy server o'rniga brauzerning o'zida ishlaydigan soxta API.
// Hech qanday ma'lumot hech qayerga yuborilmaydi; sahifa yangilansa hammasi boshidan boshlanadi.
(() => {
  const GB = 1024 ** 3, DAY = 86400000, now = Date.now();
  const realFetch = window.fetch.bind(window);

  // Soxta kutubxona: 54 ta rasm va 6 ta video
  const ASPECTS = [[3, 2], [2, 3], [16, 9], [1, 1], [4, 3], [3, 4], [3, 2], [16, 9]];
  const AGES = [0, 0, 0, 1, 1, 2, 2, 5, 5, 6, 12, 12, 13, 20, 20, 21, 33, 34, 60, 61, 62, 95, 96, 150, 151, 152, 210, 211, 300, 301, 302, 400, 401, 402, 480, 481];
  const items = [];
  for (let i = 0; i < 60; i++) {
    const video = i % 10 === 4;
    const [aw, ah] = ASPECTS[i % ASPECTS.length];
    const id = `${video ? 'v' : 'p'}${String(i + 1).padStart(2, '0')}.svg`;
    const ts = now - AGES[i % AGES.length] * DAY - ((i * 2749) % 80000) * 1000;
    items.push({
      id, name: video ? `VID_${20260000 + i}.mp4` : `IMG_${20260000 + i}.jpg`, mime: video ? 'video/mp4' : 'image/jpeg',
      kind: video ? 'video' : 'image', size: Math.round((video ? 38 : 3.4) * 1024 * 1024 * (0.6 + (i % 7) / 8)),
      width: aw >= ah ? 1200 : Math.round(1200 * aw / ah), height: aw >= ah ? Math.round(1200 * ah / aw) : 1200,
      duration: video ? 8 + (i * 13) % 140 : null, favorite: i % 9 === 0 ? 1 : 0,
      taken_at: ts, created_at: ts + 3600000, has_thumb: 1, deleted_at: null,
    });
  }
  items.sort((a, b) => b.taken_at - a.taken_at);
  const albums = [
    { id: 'a1', name: 'Yozgi sayohat', created_at: now - 40 * DAY, ids: items.filter((_, i) => i % 7 === 0).map((m) => m.id) },
    { id: 'a2', name: 'Oila', created_at: now - 30 * DAY, ids: items.filter((_, i) => i % 5 === 1).map((m) => m.id) },
    { id: 'a3', name: 'Toshkent', created_at: now - 10 * DAY, ids: items.filter((_, i) => i % 11 === 3).map((m) => m.id) },
  ];
  let nextAlbum = 4;
  const invites = [{ code: 'K7M2P-9XQ4T', quota_bytes: 10 * GB, note: 'Aka Ali', used_by: null, expires_at: null, created_at: now - DAY }];

  const live = () => items.filter((m) => !m.deleted_at);
  const used = () => items.reduce((n, m) => n + m.size, 0);
  const strip = (m) => ({ ...m });
  const err = (status, error) => Object.assign(new Error(error), { status });
  const albumOf = (id) => albums.find((a) => a.id === id) || (() => { throw err(404, 'Albom topilmadi'); })();

  const user = () => ({ id: 'demo', username: 'demo', role: 'admin', quota: 15 * GB, used: used(), files: items.length });

  function handle(method, path, q, body) {
    let m;
    if (path === '/api/me') return { loggedIn: true, user: user(), registration: 'invite' };
    if (path === '/api/config') return { registration: 'invite' };
    if (path === '/api/stats') {
      const l = live();
      return { total: l.length, images: l.filter((x) => x.kind === 'image').length, videos: l.filter((x) => x.kind === 'video').length,
        favorites: l.filter((x) => x.favorite).length, trash: items.length - l.length, ...user() };
    }
    if (path === '/api/limits') return { maxFileSize: 20 * GB, partSize: 512 * 1024 * 1024 };
    if (path === '/api/logout' || path === '/api/me/password') return { ok: true };

    if (path === '/api/media' && method === 'GET') {
      let l = live();
      if (q.get('kind')) l = l.filter((x) => x.kind === q.get('kind'));
      if (q.get('fav') === '1') l = l.filter((x) => x.favorite);
      if (q.get('album')) { const a = albumOf(q.get('album')); l = l.filter((x) => a.ids.includes(x.id)); }
      if (q.get('search')) l = l.filter((x) => x.name.toLowerCase().includes(q.get('search').toLowerCase()));
      const limit = Math.min(Number(q.get('limit')) || 120, 300), page = Math.max(Number(q.get('page')) || 1, 1);
      return { items: l.slice((page - 1) * limit, page * limit).map(strip), total: l.length, page, pages: Math.ceil(l.length / limit) || 1 };
    }
    if (path === '/api/media/bulk') {
      const ids = new Set(body.ids || []);
      const sel = items.filter((x) => ids.has(x.id));
      for (const x of sel) {
        if (body.action === 'trash') x.deleted_at = Date.now();
        else if (body.action === 'restore') x.deleted_at = null;
        else if (body.action === 'favorite') x.favorite = 1;
        else if (body.action === 'unfavorite') x.favorite = 0;
        else if (body.action === 'album-add') { const a = albumOf(body.album); if (!a.ids.includes(x.id)) a.ids.push(x.id); }
        else if (body.action === 'album-remove') { const a = albumOf(body.album); a.ids = a.ids.filter((i) => i !== x.id); }
        else if (body.action === 'purge' && x.deleted_at) items.splice(items.indexOf(x), 1);
      }
      return { ok: true, count: sel.length };
    }
    if ((m = path.match(/^\/api\/media\/([^/]+)\/share$/))) return { ok: true, token: 'demo', url: `${location.origin}${location.pathname}#paylashish-demo`, expires_at: null };
    if ((m = path.match(/^\/api\/media\/([^/]+)\/shares$/))) return { items: [] };
    if ((m = path.match(/^\/api\/media\/([^/]+)$/))) {
      const x = items.find((i) => i.id === m[1]);
      if (!x) throw err(404, 'Topilmadi');
      if (method === 'PATCH') { if (typeof body.favorite === 'boolean') x.favorite = body.favorite ? 1 : 0; return { ok: true }; }
      return { ...x, albums: [], shares: [] };
    }
    if (path === '/api/trash') return { items: items.filter((x) => x.deleted_at).sort((a, b) => b.deleted_at - a.deleted_at).map(strip) };
    if (path === '/api/trash/empty') { for (let i = items.length - 1; i >= 0; i--) if (items[i].deleted_at) items.splice(i, 1); return { ok: true }; }

    if (path === '/api/albums' && method === 'GET') {
      return { items: albums.map((a) => {
        const l = live().filter((x) => a.ids.includes(x.id));
        return { id: a.id, name: a.name, created_at: a.created_at, n: l.length, cover: l[0]?.id || null };
      }) };
    }
    if (path === '/api/albums' && method === 'POST') { const a = { id: 'a' + nextAlbum++, name: body.name, created_at: Date.now(), ids: [] }; albums.unshift(a); return { ok: true, id: a.id, name: a.name }; }
    if ((m = path.match(/^\/api\/albums\/([^/]+)$/))) {
      if (method === 'PATCH') { albumOf(m[1]).name = body.name; return { ok: true }; }
      if (method === 'DELETE') { const i = albums.findIndex((a) => a.id === m[1]); if (i >= 0) albums.splice(i, 1); return { ok: true }; }
    }
    if (path.startsWith('/api/shares/')) return { ok: true };

    if (path === '/api/upload/status') return { receivedBytes: 0 };
    if (path === '/api/upload/chunk' || path === '/api/upload/finish') throw err(403, "Bu namoyish (demo) sahifa: yuklash o'chirilgan");
    if (path === '/api/uploads') return { items: [] };

    if (path === '/api/admin/users') {
      return { items: [
        { id: 'demo', username: 'demo', role: 'admin', quota_bytes: null, disabled: 0, created_at: now - 60 * DAY, last_login_at: now, used: used(), files: items.length },
        { id: 'u2', username: 'ali', role: 'user', quota_bytes: 10 * GB, disabled: 0, created_at: now - 9 * DAY, last_login_at: now - 2 * DAY, used: 3.2 * GB, files: 412 },
        { id: 'u3', username: 'malika', role: 'user', quota_bytes: 5 * GB, disabled: 0, created_at: now - 3 * DAY, last_login_at: now - 3600000, used: 0.8 * GB, files: 96 },
      ] };
    }
    if (path === '/api/admin/invites' && method === 'GET') return { items: invites.map((i) => ({ ...i })) };
    if (path === '/api/admin/invites' && method === 'POST') {
      const codes = [];
      for (let k = 0; k < (body.count || 1); k++) {
        const code = Array.from({ length: 10 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('').replace(/^(.{5})/, '$1-');
        invites.unshift({ code, quota_bytes: body.quotaGB == null ? null : body.quotaGB * GB, note: body.note || null, used_by: null, expires_at: null, created_at: Date.now() });
        codes.push(code);
      }
      return { ok: true, codes };
    }
    if (path.startsWith('/api/admin/')) return { ok: true };
    throw err(404, 'Demo: bu amal mavjud emas');
  }

  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    await new Promise((r) => setTimeout(r, 60));   // haqiqiy tarmoq kechikishiga o'xshatish
    let body = null;
    try { body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch {}
    try {
      const out = handle((opts.method || 'GET').toUpperCase(), url.pathname, url.searchParams, body || {});
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: e.status || 500, headers: { 'Content-Type': 'application/json' } });
    }
  };

  // Demo belgisi
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'DEMO — soxta ma\'lumotlar, hech narsa saqlanmaydi';
    b.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:200;background:#fbbc04;color:#202124;font:600 11px system-ui;padding:3px 12px;border-radius:0 0 8px 8px;pointer-events:none';
    document.body.appendChild(b);
  });
})();
