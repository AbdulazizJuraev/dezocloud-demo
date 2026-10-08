// DezoCloud — asosiy dastur
import {
  $, $$, icon, hydrateIcons, esc, bytes, duration, dayKey, dayLabel, monthKey, monthLabel, api, toast,
  modal, promptText, confirmBox, openMenu, copyText,
} from './util.js';
import { initUploader, enqueue, hasActive } from './uploader.js';
import { openViewer, close as closeViewer, isOpen as viewerOpen, refreshViewer } from './viewer.js';

const state = {
  user: null,
  view: 'photos',        // photos | videos | favorites | albums | album | trash
  albumId: null,
  albums: [],
  items: [],
  page: 1, pages: 1, total: 0,
  loading: false,
  search: '',
  selected: new Set(),
  stats: {},
  maxFileSize: Infinity,
  token: 0,               // eskirgan javoblarni e'tiborsiz qoldirish uchun
};

const main = $('#main');
const TITLES = { photos: 'Fotolar', videos: 'Videolar', favorites: 'Sevimlilar', albums: 'Albomlar', trash: 'Savatcha' };

// ── Ishga tushirish ───────────────────────────────────────────────
hydrateIcons();
$('#menu-btn').innerHTML = icon('menu');

(async function init() {
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    if (!me.loggedIn) { location.href = './login.html'; return; }
    state.user = me.user;
  } catch { location.href = './login.html'; return; }

  $('#avatar').textContent = state.user.username[0];
  api('/api/limits').then((l) => { state.maxFileSize = l.maxFileSize; }).catch(() => {});
  initUploader({
    getAlbum: () => (state.view === 'album' ? state.albumId : null),
    onProgressDone: () => { loadStats(); if (main.scrollTop < 400) scheduleRefresh(); },
    onAllDone: () => { loadStats(); loadAlbums(); reload(); },
  });
  await Promise.all([loadStats(), loadAlbums()]);
  route();
})();

// ── Yo'naltirish (hash) ───────────────────────────────────────────
function parseHash() {
  const [, a, b] = location.hash.replace(/^#/, '').split('/');
  if (a === 'album' && b) return { view: 'album', albumId: decodeURIComponent(b) };
  return { view: TITLES[a] ? a : 'photos', albumId: null };
}

function navigate(h) {
  if (location.hash === h) route(); else location.hash = h;
}

window.addEventListener('hashchange', () => { if (!viewerOpen()) route(); });

function route() {
  const { view, albumId } = parseHash();
  state.view = view;
  state.albumId = albumId;
  state.selected.clear();
  closeSide();
  syncNav();
  updateSelUI();
  if (view !== 'albums') {
    // qidiruv faqat suratlar ro'yxatida ma'noli
  }
  reload();
}

function syncNav() {
  const active = state.view === 'album' ? 'albums' : state.view;
  $$('#nav button, #tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === active));
  const album = state.view === 'album' ? state.albums.find((a) => a.id === state.albumId) : null;
  document.title = `${album ? album.name : TITLES[state.view]} — DezoCloud`;
}

$$('#nav button, #tabbar button').forEach((b) => {
  b.onclick = () => { $('#search').value = ''; state.search = ''; $('#search-clear').hidden = true; navigate(`#/${b.dataset.view}`); };
});

// Yon panelni yig'ish (kompyuter) / ochish (telefon)
const wide = matchMedia('(min-width: 901px)');
try { if (localStorage.getItem('dc-side') === 'off') $('#app').classList.add('noside'); } catch {}
$('#menu-btn').onclick = () => {
  if (wide.matches) {
    const off = $('#app').classList.toggle('noside');
    try { localStorage.setItem('dc-side', off ? 'off' : 'on'); } catch {}
  } else {
    const open = $('#side').classList.toggle('open');
    $('#scrim').hidden = !open;
  }
};
$('#scrim').onclick = closeSide;
function closeSide() { $('#side').classList.remove('open'); $('#scrim').hidden = true; }

// ── Ma'lumot yuklash ──────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await api('/api/stats');
    state.stats = s;
    state.user = { ...state.user, used: s.used, quota: s.quota };
    $('#c-photos').textContent = s.total || '';
    $('#c-videos').textContent = s.videos || '';
    $('#c-fav').textContent = s.favorites || '';
    $('#c-trash').textContent = s.trash || '';
    const meter = $('#meter');
    meter.hidden = false;
    const pct = s.quota ? Math.min(100, (s.used / s.quota) * 100) : 0;
    $('#meter-fill').style.width = `${s.quota ? Math.max(pct, 1) : 0}%`;
    meter.classList.toggle('full', pct >= 90);
    $('#meter-text').textContent = s.quota ? `${bytes(s.used)} / ${bytes(s.quota)} ishlatilgan` : `${bytes(s.used)} ishlatilgan`;
  } catch {}
}

async function loadAlbums() {
  try {
    state.albums = (await api('/api/albums')).items;
    syncNav();
    if (state.view === 'albums') renderAlbums();
  } catch {}
}

function listParams(page) {
  const p = new URLSearchParams({ page, limit: 150 });
  if (state.view === 'videos') p.set('kind', 'video');
  if (state.view === 'favorites') p.set('fav', '1');
  if (state.view === 'album') p.set('album', state.albumId);
  if (state.search) p.set('search', state.search);
  return p;
}

let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(reload, 1500); }

/** Ko'rinishni boshidan yuklaydi. */
async function reload() {
  clearTimeout(refreshTimer);
  const token = ++state.token;
  state.items = []; state.page = 1; state.pages = 1; state.total = 0;

  if (state.view === 'albums' && !state.search) { renderAlbums(); return; }
  main.innerHTML = '<div class="loading">Yuklanmoqda…</div>';
  try {
    if (state.view === 'trash') {
      const { items } = await api('/api/trash');
      if (token !== state.token) return;
      state.items = items; state.total = items.length;
    } else {
      const d = await api(`/api/media?${listParams(1)}`);
      if (token !== state.token) return;
      state.items = d.items; state.pages = d.pages; state.total = d.total;
    }
  } catch (e) {
    if (token !== state.token) return;
    if (state.view === 'album') { toast(e.message); navigate('#/albums'); return; }
    main.innerHTML = `<div class="emptyview"><h3>Yuklab bo'lmadi</h3>${esc(e.message)}</div>`;
    return;
  }
  renderTimeline();
}

async function loadMore() {
  if (state.loading || state.page >= state.pages || state.view === 'trash') return;
  state.loading = true;
  const token = state.token;
  try {
    const d = await api(`/api/media?${listParams(state.page + 1)}`);
    if (token !== state.token) return;
    state.page++; state.pages = d.pages;
    const known = new Set(state.items.map((m) => m.id));
    const fresh = d.items.filter((m) => !known.has(m.id));
    state.items.push(...fresh);
    appendItems(fresh);
  } catch (e) { toast(e.message); } finally { state.loading = false; }
}

// ── Vaqt chizig'i ─────────────────────────────────────────────────
let lastKey = null;
let lastGroup = null;
let lastMonth = null;
let lastDays = null;
let lastBlock = null;
let observer = null;

function pageHead() {
  const t = state.search ? `Qidiruv: «${esc(state.search)}»` : (state.view === 'album' || state.view === 'photos' ? '' : TITLES[state.view]);
  let h = '';
  let warn = '';
  const q = state.user;
  if (q?.quota && q.used / q.quota >= 0.9) {
    warn = `<div class="storewarn">Joy tugayapti (band: ${Math.min(100, Math.round((q.used / q.quota) * 100))}%). To'lganda yangi surat yuklab bo'lmaydi — keraksiz fayllarni o'chiring yoki administratordan joy so'rang.</div>`;
  }
  if (state.view === 'album') {
    const a = state.albums.find((x) => x.id === state.albumId);
    h = `<div class="page-head"><button class="icon-btn" data-act="back" aria-label="Orqaga">${icon('back')}</button>
      <h2>${esc(a?.name || 'Albom')}</h2><span class="sub">${state.total} ta</span><span class="grow"></span>
      <button class="icon-btn" data-act="album-menu" aria-label="Albom amallari">${icon('more')}</button></div>`;
  } else if (state.view === 'trash') {
    h = `<div class="page-head"><h2>Savatcha</h2><span class="grow"></span>
      ${state.items.length ? '<button class="btn sm danger" data-act="empty-trash">Savatchani bo\'shatish</button>' : ''}</div>
      <div class="notice">Savatchadagi fayllar 30 kundan keyin butunlay o'chiriladi. Ular hajmingizdan hisoblanadi.</div>`;
  } else if (t) {
    h = `<div class="page-head"><h2>${t}</h2>${state.total ? `<span class="sub">${state.total} ta</span>` : ''}</div>`;
  }
  return warn + h;
}

function emptyHtml() {
  const e = (ic, title, text, btn = '') => `<div class="emptyview">${icon(ic)}<h3>${title}</h3>${text}${btn}</div>`;
  const up = '<br><button class="btn primary" data-act="upload">Yuklash</button>';
  if (state.search) return e('search', 'Hech narsa topilmadi', `«${esc(state.search)}» bo'yicha natija yo'q.`);
  switch (state.view) {
    case 'videos': return e('video', "Hali video yo'q", 'Video yuklang — shu yerda ko\'rinadi.', up);
    case 'favorites': return e('star', "Sevimlilar yo'q", "Surat ustidagi ★ tugmasini bosing.");
    case 'album': return e('album', "Albom bo'sh", "Fotolardan tanlab, «Albomga qo'shish» ni bosing yoki shu yerning o'zida yuklang.", up);
    case 'trash': return e('delete', 'Savatcha bo\'sh', 'O\'chirilgan fayllar shu yerga tushadi.');
    default: return e('photo', "Hali surat yo'q", "Surat va videolaringizni yuklang — ular shu yerda sana bo'yicha tartiblanadi.", up);
  }
}

function renderTimeline() {
  disconnectObserver();
  lastKey = null; lastGroup = null; lastMonth = null; lastDays = null; lastBlock = null;
  syncNav();
  main.innerHTML = pageHead() + '<div id="tl"></div>';
  $('#tl').classList.toggle('selecting', state.selected.size > 0);
  if (!state.items.length) { $('#tl').innerHTML = emptyHtml(); hydrateIcons($('#tl')); hydrateIcons(main); return; }
  appendItems(state.items);
  hydrateIcons(main);
  if (state.page < state.pages) {
    const s = document.createElement('div');
    s.id = 'sentinel';
    main.appendChild(s);
    observer = new IntersectionObserver((en) => { if (en[0].isIntersecting) loadMore(); }, { root: main, rootMargin: '800px' });
    observer.observe(s);
  }
}

function disconnectObserver() { observer?.disconnect(); observer = null; }

function appendItems(items) {
  const tl = $('#tl');
  if (!tl) return;
  for (const m of items) {
    const ts = m.taken_at || m.created_at || m.deleted_at;
    const key = state.view === 'trash' ? 'trash' : dayKey(ts);
    if (key !== lastKey) {
      lastGroup = document.createElement('div');
      lastGroup.className = 'group';
      lastGroup.dataset.key = key;
      if (state.view === 'trash') {
        tl.appendChild(lastGroup);
      } else {
        // Oy sarlavhasi (kompyuterda katta yozuv) va kun bloki: qisqa kunlar bir qatorga yonma-yon tushadi
        const mk = monthKey(ts);
        if (mk !== lastMonth) {
          const mh = document.createElement('h3');
          mh.className = 'month';
          mh.textContent = monthLabel(ts);
          lastDays = document.createElement('div');
          lastDays.className = 'days';
          tl.append(mh, lastDays);
          lastMonth = mk;
        }
        const h = document.createElement('div');
        h.className = 'day';
        h.dataset.key = key;
        h.innerHTML = `<button class="daycheck" data-act="day" aria-label="Kunni tanlash">${icon('check')}</button><span>${esc(dayLabel(ts))}</span>`;
        lastBlock = document.createElement('div');
        lastBlock.className = 'dayblock';
        lastBlock.style.setProperty('--sar', '0');
        lastBlock.style.setProperty('--n', '0');
        lastBlock.append(h, lastGroup);
        lastDays.appendChild(lastBlock);
      }
      lastKey = key;
    }
    const tile = tileEl(m);
    lastGroup.appendChild(tile);
    if (lastBlock && state.view !== 'trash') {   // blok kengligi = bir qatordagi surat kengliklari yig'indisi
      lastBlock.style.setProperty('--sar', String((Number(lastBlock.style.getPropertyValue('--sar')) + Number(tile.style.getPropertyValue('--ar'))).toFixed(3)));
      lastBlock.style.setProperty('--n', String(lastGroup.children.length));
    }
  }
  const sent = $('#sentinel');
  if (sent && observer) { observer.unobserve(sent); observer.observe(sent); }
}

function tileEl(m) {
  const el = document.createElement('div');
  const sel = state.selected.has(m.id);
  el.className = `ph${m.favorite ? ' isfav' : ''}${sel ? ' sel' : ''}`;
  el.dataset.id = m.id;
  el.tabIndex = 0;
  const ar = m.width && m.height ? Math.min(3, Math.max(0.5, m.width / m.height)) : 1;
  el.style.setProperty('--ar', ar.toFixed(3));
  el.innerHTML = (m.has_thumb
    ? `<img loading="lazy" decoding="async" alt="" src="./t/${m.id}">`
    : `<div class="fallback">${icon(m.kind === 'video' ? 'video' : 'photo')}</div>`)
    + '<div class="shade"></div>'
    + `<button class="chk" tabindex="-1" aria-label="Tanlash">${icon(sel ? 'check' : 'circle')}</button>`
    + (m.kind === 'video' ? `<div class="vbadge">${icon('play')}${m.duration ? duration(m.duration) : ''}</div>` : '')
    + `<div class="fav">${icon('star')}</div>`;
  return el;
}

// Eskiz yuklanmasa (masalan buzilgan) - o'rniga belgi
main.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('.ph')) return;
  const f = document.createElement('div');
  f.className = 'fallback';
  f.innerHTML = icon('photo');
  img.replaceWith(f);
}, true);

main.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', main.scrollTop > 2), { passive: true });

// ── Tanlash ───────────────────────────────────────────────────────
let lastClickId = null;
let longPressed = false;
let pressTimer = null;

function toggleSelect(id, on) {
  const want = on ?? !state.selected.has(id);
  want ? state.selected.add(id) : state.selected.delete(id);
  const el = main.querySelector(`.ph[data-id="${CSS.escape(id)}"]`);
  if (el) { el.classList.toggle('sel', want); $('.chk', el).innerHTML = icon(want ? 'check' : 'circle'); }
}

function updateSelUI() {
  $('#tl')?.classList.toggle('selecting', state.selected.size > 0);
  const bar = $('#selbar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (!n) { syncDayChecks(); return; }
  const btn = (a, ic, label) => `<button class="icon-btn" data-sel="${a}" aria-label="${label}" title="${label}">${icon(ic)}</button>`;
  const trash = state.view === 'trash';
  bar.innerHTML = `${btn('clear', 'close', 'Bekor qilish')}<span class="cnt">${n} ta tanlandi</span>`
    + (trash
      ? btn('restore', 'restore', 'Tiklash') + btn('purge', 'delete', "Butunlay o'chirish")
      : btn('fav', 'star', 'Sevimlilarga') + btn('album', 'album', "Albomga qo'shish") + btn('download', 'download', 'Yuklab olish')
        + (state.view === 'album' ? btn('unalbum', 'remove', 'Albomdan olib tashlash') : '') + btn('trash', 'delete', 'Savatchaga'));
  syncDayChecks();
}

function syncDayChecks() {
  $$('.day', main).forEach((d) => {
    const ids = $$(`.group[data-key="${d.dataset.key}"] .ph`, main).map((p) => p.dataset.id);
    $('.daycheck', d).classList.toggle('on', ids.length > 0 && ids.every((id) => state.selected.has(id)));
  });
}

const selectedItems = () => state.items.filter((m) => state.selected.has(m.id));

main.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) return handleAct(act, e);

  const ph = e.target.closest('.ph');
  if (!ph) return;
  const id = ph.dataset.id;
  if (longPressed) { longPressed = false; return; }

  if (e.target.closest('.chk') || state.selected.size > 0) {
    if (e.shiftKey && lastClickId && state.selected.size) {
      const ids = state.items.map((m) => m.id);
      const [a, b] = [ids.indexOf(lastClickId), ids.indexOf(id)].sort((x, y) => x - y);
      for (const k of ids.slice(a, b + 1)) toggleSelect(k, true);
    } else toggleSelect(id);
    lastClickId = id;
    return updateSelUI();
  }
  const i = state.items.findIndex((m) => m.id === id);
  if (i >= 0) openViewer(state.items, i, viewerCtx());
});

main.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList?.contains('ph')) e.target.click();
});

// Telefonda uzoq bosish = tanlashni boshlash
main.addEventListener('touchstart', (e) => {
  const ph = e.target.closest('.ph');
  if (!ph) return;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressed = true;
    toggleSelect(ph.dataset.id, true);
    updateSelUI();
    navigator.vibrate?.(15);
  }, 450);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) main.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
main.addEventListener('contextmenu', (e) => { if (e.target.closest('.ph') && matchMedia('(pointer: coarse)').matches) e.preventDefault(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected.size && !viewerOpen() && !$('.modal-back')) { state.selected.clear(); $$('.ph.sel', main).forEach((p) => { p.classList.remove('sel'); $('.chk', p).innerHTML = icon('circle'); }); updateSelUI(); }
});

$('#selbar').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-sel]')?.dataset.sel;
  if (!a) return;
  const ids = [...state.selected];
  const items = selectedItems();
  try {
    if (a === 'clear') { clearSelection(); }
    else if (a === 'fav') {
      const allFav = items.length && items.every((m) => m.favorite);
      await bulk(allFav ? 'unfavorite' : 'favorite', ids);
      items.forEach((m) => { m.favorite = allFav ? 0 : 1; refreshTile(m); });
      toast(allFav ? 'Sevimlilardan olindi' : 'Sevimlilarga qo\'shildi');
      if (state.view === 'favorites' && allFav) removeLocal(ids);
      clearSelection(); loadStats();
    } else if (a === 'trash') { await bulk('trash', ids); removeLocal(ids); toast(`${ids.length} ta fayl savatchaga olindi`); loadStats(); loadAlbums(); }
    else if (a === 'restore') { await bulk('restore', ids); removeLocal(ids); toast(`${ids.length} ta fayl tiklandi`); loadStats(); loadAlbums(); }
    else if (a === 'purge') {
      if (await confirmBox({ title: `${ids.length} ta faylni butunlay o'chirish`, text: "Bu amalni bekor qilib bo'lmaydi.", ok: "O'chirish", danger: true })) {
        await bulk('purge', ids); removeLocal(ids); toast("Butunlay o'chirildi"); loadStats();
      }
    } else if (a === 'album') { await pickAlbum(ids); }
    else if (a === 'unalbum') { await bulk('album-remove', ids, { album: state.albumId }); removeLocal(ids); toast('Albomdan olib tashlandi'); loadAlbums(); }
    else if (a === 'download') { downloadMany(items); }
  } catch (err) { toast(err.message); }
});

function clearSelection() {
  state.selected.clear();
  $$('.ph.sel', main).forEach((p) => { p.classList.remove('sel'); $('.chk', p).innerHTML = icon('circle'); });
  updateSelUI();
}

function downloadMany(items) {
  items.forEach((m, i) => setTimeout(() => {
    const l = document.createElement('a');
    l.href = `/f/${m.id}?dl=1`; l.download = m.name;
    document.body.appendChild(l); l.click(); l.remove();
  }, i * 400));
  if (items.length > 1) toast('Yuklab olish boshlandi. Brauzer bir nechta faylga ruxsat so\'rashi mumkin.', 5000);
}

// ── Amallar ───────────────────────────────────────────────────────
async function bulk(action, ids, extra = {}) {
  return api('/api/media/bulk', { method: 'POST', body: { action, ids, ...extra } });
}

function refreshTile(m) {
  const old = main.querySelector(`.ph[data-id="${CSS.escape(m.id)}"]`);
  if (old) old.replaceWith(tileEl(m));
}

/** Fayllarni ro'yxatdan va ekrandan olib tashlaydi. */
function removeLocal(ids) {
  const gone = new Set(ids);
  for (let i = state.items.length - 1; i >= 0; i--) if (gone.has(state.items[i].id)) state.items.splice(i, 1);
  state.total = Math.max(0, state.total - gone.size);
  gone.forEach((id) => state.selected.delete(id));
  for (const id of gone) main.querySelector(`.ph[data-id="${CSS.escape(id)}"]`)?.remove();
  $$('.group', main).forEach((g) => {
    if (!g.children.length) { g.previousElementSibling?.classList.contains('day') && g.previousElementSibling.remove(); g.remove(); }
  });
  if (!state.items.length && state.page >= state.pages) renderTimeline();
  updateSelUI();
  refreshViewer();
}

function viewerCtx() {
  const trash = state.view === 'trash';
  return {
    trash,
    favorite: async (m) => {
      const want = !m.favorite;
      await api(`/api/media/${m.id}`, { method: 'PATCH', body: { favorite: want } });
      m.favorite = want ? 1 : 0;
      refreshTile(m);
      loadStats();
      if (state.view === 'favorites' && !want) { /* ro'yxatdan chiqadi, lekin ko'rish oynasida qoladi */ }
    },
    trashIt: async (m) => { await bulk('trash', [m.id]); removeLocal([m.id]); toast('Savatchaga olindi'); loadStats(); loadAlbums(); },
    restore: async (m) => { await bulk('restore', [m.id]); removeLocal([m.id]); toast('Tiklandi'); loadStats(); },
    purge: async (m) => {
      if (!(await confirmBox({ title: "Butunlay o'chirish", text: `«${m.name}» qaytarib bo'lmaydigan tarzda o'chiriladi.`, ok: "O'chirish", danger: true }))) return false;
      await bulk('purge', [m.id]); removeLocal([m.id]); toast("O'chirildi"); loadStats();
      return true;
    },
    share: (m) => shareDialog(m),
    album: (m) => pickAlbum([m.id]),
  };
}

// ── Albomga qo'shish ──────────────────────────────────────────────
function pickAlbum(ids) {
  return new Promise((resolve) => {
    const m = modal(`
      <h2>Albomga qo'shish</h2>
      <div class="list">
        <button data-new="1"><span style="color:var(--accent)">${icon('add')}</span><b>Yangi albom</b></button>
        ${state.albums.map((a) => `<button data-id="${esc(a.id)}"><span style="color:var(--muted)">${icon('album')}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span>
          <span style="color:var(--muted);font-size:12px">${a.n}</span></button>`).join('')}
      </div>
      <div class="actions"><button class="btn" data-x="c">Bekor</button></div>`);
    $('[data-x="c"]', m).onclick = () => { m.close(); resolve(); };
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('.list button');
      if (!b) return;
      try {
        let id = b.dataset.id;
        let name = state.albums.find((a) => a.id === id)?.name;
        if (b.dataset.new) {
          m.close();
          name = await promptText({ title: 'Yangi albom', label: 'Albom nomi', ok: 'Yaratish' });
          if (!name) return resolve();
          id = (await api('/api/albums', { method: 'POST', body: { name } })).id;
        } else m.close();
        await bulk('album-add', ids, { album: id });
        toast(`«${name}» albomiga qo'shildi`);
        clearSelection();
        loadAlbums();
        resolve();
      } catch (err) { toast(err.message); resolve(); }
    });
  });
}

// ── Albomlar ro'yxati ─────────────────────────────────────────────
function renderAlbums() {
  disconnectObserver();
  syncNav();
  main.innerHTML = `<div class="page-head"><h2>Albomlar</h2><span class="grow"></span></div>
    <div class="albums">
      <div class="album new" data-act="new-album"><div class="cover">${icon('add')}</div><div class="nm">Yangi albom</div></div>
      ${state.albums.map((a) => `<div class="album" data-album="${esc(a.id)}">
        <div class="cover">${a.cover ? `<img loading="lazy" alt="" src="./t/${a.cover}">` : `<div class="fallback">${icon('album')}</div>`}</div>
        <div class="nm">${esc(a.name)}</div><div class="ct">${a.n} ta</div></div>`).join('')}
    </div>`;
  hydrateIcons(main);
}

async function handleAct(act, e) {
  try {
    if (act === 'new-album') {
      const name = await promptText({ title: 'Yangi albom', label: 'Albom nomi', ok: 'Yaratish' });
      if (!name) return;
      const a = await api('/api/albums', { method: 'POST', body: { name } });
      await loadAlbums();
      navigate(`#/album/${a.id}`);
    } else if (act === 'upload') $('#file').click();
    else if (act === 'back') navigate('#/albums');
    else if (act === 'day') {
      const key = e.target.closest('.day').dataset.key;
      const ids = $$(`.group[data-key="${key}"] .ph`, main).map((p) => p.dataset.id);
      const on = !ids.every((id) => state.selected.has(id));
      ids.forEach((id) => toggleSelect(id, on));
      updateSelUI();
    } else if (act === 'album-menu') {
      const a = state.albums.find((x) => x.id === state.albumId);
      const m = openMenu(e.target.closest('button'), `
        <button data-m="rename">${icon('edit')}Nomini o'zgartirish</button>
        <button data-m="del" style="color:var(--danger)">${icon('delete')}Albomni o'chirish</button>`);
      m.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-m]')?.dataset.m;
        if (k === 'rename') {
          const name = await promptText({ title: 'Albom nomi', label: 'Yangi nom', value: a?.name || '' });
          if (name) { await api(`/api/albums/${state.albumId}`, { method: 'PATCH', body: { name } }); await loadAlbums(); renderTimeline(); }
        } else if (k === 'del') {
          if (await confirmBox({ title: `«${a?.name}» albomini o'chirish`, text: "Suratlar va videolar kutubxonada qoladi, faqat albom o'chadi.", ok: "O'chirish", danger: true })) {
            await api(`/api/albums/${state.albumId}`, { method: 'DELETE' });
            await loadAlbums();
            navigate('#/albums');
          }
        }
      });
    } else if (act === 'empty-trash') {
      if (await confirmBox({ title: "Savatchani bo'shatish", text: `${state.items.length} ta fayl butunlay o'chiriladi. Bu amalni bekor qilib bo'lmaydi.`, ok: "Bo'shatish", danger: true })) {
        await api('/api/trash/empty', { method: 'POST' });
        state.items = []; state.total = 0;
        renderTimeline();
        toast("Savatcha bo'shatilmoqda…");
        setTimeout(loadStats, 2500);
      }
    }
  } catch (err) { toast(err.message); }
}

main.addEventListener('click', (e) => {
  const al = e.target.closest('.album[data-album]');
  if (al) navigate(`#/album/${al.dataset.album}`);
});

// ── Ulashish ──────────────────────────────────────────────────────
async function shareDialog(m) {
  let shares = [];
  try { shares = (await api(`/api/media/${m.id}/shares`)).items; } catch {}

  const draw = () => {
    const live = shares.filter((s) => !s.expires_at || s.expires_at > Date.now());
    return `
      <h2>Ulashish</h2>
      <div style="color:var(--muted);font-size:13px;margin-top:-6px">Havola bor har kim «${esc(m.name)}» faylini ko'ra oladi (kirish shart emas).</div>
      <label class="field"><span>Havola amal qilish muddati</span>
        <select id="sh-days" style="height:44px;border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:0 10px">
          <option value="7">7 kun</option><option value="30" selected>30 kun</option><option value="0">Muddatsiz</option>
        </select></label>
      <div class="actions" style="justify-content:flex-start"><button class="btn primary" data-x="make">${icon('link')}Havola yaratish</button></div>
      <div id="sh-new"></div>
      ${live.length ? `<div style="font-size:12px;color:var(--muted)">Mavjud havolalar</div><div class="list">${live.map((s) => `
        <button data-copy="${esc(s.url)}" style="gap:8px"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${esc(s.url)}</span>
        <span style="color:var(--muted);font-size:11px">${s.hits} ko'rish</span>
        <span data-del="${esc(s.token)}" title="O'chirish" style="color:var(--danger)">${icon('close')}</span></button>`).join('')}</div>` : ''}
      <div class="actions"><button class="btn" data-x="c">Yopish</button></div>`;
  };

  const el = modal(draw());
  const rebind = () => {
    $('[data-x="c"]', el).onclick = () => el.close();
    $('[data-x="make"]', el).onclick = async () => {
      try {
        const days = Number($('#sh-days', el).value);
        const r = await api(`/api/media/${m.id}/share`, { method: 'POST', body: { days } });
        shares.unshift({ token: r.token, url: r.url, expires_at: r.expires_at, hits: 0 });
        el.innerHTML = draw(); hydrateIcons(el); rebind();
        $('#sh-new', el).innerHTML = `<div class="copyrow"><input readonly value="${esc(r.url)}" id="sh-url"><button class="btn primary" data-copy="${esc(r.url)}">Nusxalash</button></div>`;
        await copyText(r.url); toast('Havola yaratildi va nusxalandi');
      } catch (err) { toast(err.message); }
    };
  };
  rebind();
  el.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      await api(`/api/shares/${del.dataset.del}`, { method: 'DELETE' }).catch((x) => toast(x.message));
      shares = shares.filter((s) => s.token !== del.dataset.del);
      el.innerHTML = draw(); hydrateIcons(el); rebind();
      return;
    }
    const c = e.target.closest('[data-copy]');
    if (c) toast((await copyText(c.dataset.copy)) ? 'Havola nusxalandi' : "Nusxalab bo'lmadi");
  });
}

// ── Qidiruv ───────────────────────────────────────────────────────
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  $('#search-clear').hidden = !e.target.value;
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    if (state.view === 'albums' || state.view === 'trash') { navigate('#/photos'); return; }
    reload();
  }, 300);
});
$('#search-clear').onclick = () => { $('#search').value = ''; $('#search-clear').hidden = true; state.search = ''; reload(); };

// ── Yuklash tugmalari ─────────────────────────────────────────────
$('#upload-btn').onclick = () => $('#file').click();
$('#fab').onclick = () => $('#file').click();
$('#file').onchange = (e) => { enqueue(e.target.files, { maxFileSize: state.maxFileSize }); e.target.value = ''; };

// Faylni sudrab tashlash
let dragDepth = 0;
const veil = () => $('.dropveil');
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  if (!veil()) { const v = document.createElement('div'); v.className = 'dropveil'; v.textContent = 'Yuklash uchun shu yerga tashlang'; document.body.appendChild(v); }
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil()?.remove(); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault(); dragDepth = 0; veil()?.remove();
  enqueue(e.dataTransfer.files, { maxFileSize: state.maxFileSize });
});

// ── Hisob menyusi ─────────────────────────────────────────────────
$('#avatar').onclick = (e) => {
  const u = state.user;
  const quota = u.quota ? `${bytes(u.used)} / ${bytes(u.quota)}` : `${bytes(u.used)} (cheksiz)`;
  const m = openMenu(e.currentTarget, `
    <div class="head"><b>${esc(u.username)}</b>${u.email ? `<span>${esc(u.email)}</span>` : ''}<span>${esc(quota)}</span></div>
    ${u.hasPassword === false ? '' : `<button data-m="pw">${icon('lock')}Parolni o'zgartirish</button>`}
    ${u.role === 'admin' ? `<a href="./admin.html">${icon('shield')}Administrator paneli</a>` : ''}
    <button data-m="out">${icon('logout')}Chiqish</button>`);
  m.addEventListener('click', async (ev) => {
    const k = ev.target.closest('[data-m]')?.dataset.m;
    if (k === 'out') {
      if (hasActive() && !(await confirmBox({ title: 'Chiqishni xohlaysizmi?', text: 'Yuklash hali tugamagan, chiqsangiz to\'xtaydi.', ok: 'Chiqish' }))) return;
      await fetch('/api/logout', { method: 'POST' });
      location.href = './login.html';
    } else if (k === 'pw') passwordDialog();
  });
};

function passwordDialog() {
  const m = modal(`
    <h2>Parolni o'zgartirish</h2>
    <label class="field"><span>Joriy parol</span><input id="pw0" type="password" autocomplete="current-password"></label>
    <label class="field"><span>Yangi parol</span><input id="pw1" type="password" autocomplete="new-password"><small>Kamida 8 ta belgi. Boshqa qurilmalardagi kirishlar tugatiladi.</small></label>
    <div class="msg" id="pw-msg"></div>
    <div class="actions"><button class="btn" data-x="c">Bekor</button><button class="btn primary" data-x="ok">O'zgartirish</button></div>`);
  $('#pw0', m).focus();
  $('[data-x="c"]', m).onclick = () => m.close();
  $('[data-x="ok"]', m).onclick = async () => {
    try {
      await api('/api/me/password', { method: 'POST', body: { current: $('#pw0', m).value, next: $('#pw1', m).value } });
      m.close(); toast("Parol o'zgartirildi");
    } catch (e) { $('#pw-msg', m).textContent = e.message; }
  };
}
