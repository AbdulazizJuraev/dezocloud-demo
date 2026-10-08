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
const TITLES = {
  photos: 'Fotolar', videos: 'Videolar', favorites: 'Sevimlilar', albums: 'Albomlar', places: 'Joylar',
  recent: "Yaqinda qo'shilgan", archive: 'Arxiv', trash: 'Savatcha', plans: 'Tariflar', collections: "To'plamlar", storage: 'Xotira',
};

// Xotira: keraksiz fayl toifalari
const CLEAN_HINTS = {
  large: "Eng katta fayllar eng tepada: ular xotirani ko'p egallaydi.",
  dupes: "Bir xil nom va hajmdagi fayllarning keyingi nusxalari (eng eskisi tegilmaydi).",
  screens: "Nomi «screenshot» yoki «ekran» bo'lgan suratlar.",
  unsupported: "Bu formatdagi videolar brauzerda ijro etilmaydi: yuklab olib ko'rish mumkin.",
};
const CLEAN_TITLES = {
  large: 'Katta hajmli surat va videolar',
  dupes: 'Takroriy fayllar',
  screens: 'Skrinshotlar',
  unsupported: "Brauzerda ochilmaydigan videolar",
};

// Joy katagi (~10 km) nomi: koordinatalar
const placeName = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

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
  if (a === 'album' && b) return { view: 'album', albumId: decodeURIComponent(b), place: null };
  if (a === 'place' && /^-?\d+,-?\d+$/.test(decodeURIComponent(b || ''))) return { view: 'place', albumId: null, place: decodeURIComponent(b) };
  if (a === 'cleanup' && CLEAN_TITLES[b]) return { view: 'cleanup', albumId: null, place: null, clean: b };
  return { view: TITLES[a] ? a : 'photos', albumId: null, place: null };
}

function navigate(h) {
  if (location.hash === h) route(); else location.hash = h;
}

window.addEventListener('hashchange', () => { if (!viewerOpen()) route(); });

function route() {
  const { view, albumId, place, clean } = parseHash();
  state.clean = clean || null;
  state.view = view;
  state.albumId = albumId;
  state.place = place;
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
  const active = state.view === 'album' ? 'albums' : state.view === 'place' ? 'places' : state.view;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === active));
  // Pastki panel: Fotolar yoki To'plamlar (qolgan hamma bo'limlar to'plamlarga kiradi)
  const tab = ['photos', 'collections'].includes(state.view) ? state.view : (state.view === 'photos' ? 'photos' : 'collections');
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === tab));
  const album = state.view === 'album' ? state.albums.find((a) => a.id === state.albumId) : null;
  document.title = `${album ? album.name : (state.view === 'cleanup' ? CLEAN_TITLES[state.clean] : TITLES[state.view]) || TITLES.places} — DezoCloud`;
}

$$('#nav button, #tabbar button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.view === 'search') return openSearchPage();
    if (b.dataset.view === 'upload') return $('#file').click();
    closeMobileSearch(true);
    $('#search').value = ''; state.search = ''; $('#search-clear').hidden = true; navigate(`#/${b.dataset.view}`);
  };
});

// ── Qidiruv sahifasi (telefonda): alohida to'liq ekran, Google Photos kabi ─────
const RECENT_KEY = 'dc-recent-search';
const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const addRecent = (q) => {
  q = q.trim(); if (!q) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...getRecent().filter((x) => x !== q)].slice(0, 8))); } catch {}
};
let searchOpen = false;
let spTimer;

function openSearchPage() {
  let el = $('#search-page');
  if (!el) {
    el = document.createElement('div');
    el.id = 'search-page';
    el.className = 'search-page';
    el.innerHTML = `
      <div class="sp-top">
        <button class="icon-btn" id="sp-back" aria-label="Orqaga">${icon('back')}</button>
        <input id="sp-input" type="search" placeholder="Suratlar ichidan qidirish" autocomplete="off" enterkeyhint="search">
        <button class="icon-btn" id="sp-clear" aria-label="Tozalash" hidden>${icon('close')}</button>
      </div>
      <div class="sp-body" id="sp-body"></div>`;
    document.body.appendChild(el);
    $('#sp-back').onclick = () => closeSearchPage();
    $('#sp-clear').onclick = () => { $('#sp-input').value = ''; $('#sp-clear').hidden = true; spHome(); $('#sp-input').focus(); };
    $('#sp-input').addEventListener('input', (e) => {
      $('#sp-clear').hidden = !e.target.value;
      clearTimeout(spTimer);
      spTimer = setTimeout(() => spRun(e.target.value.trim()), 250);
    });
    $('#sp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { addRecent(e.target.value); e.target.blur(); } });
    $('#sp-body').addEventListener('click', (e) => {
      const go = e.target.closest('[data-sgo]');
      if (go) { closeSearchPage(true); navigate(go.dataset.sgo); return; }
      const rc = e.target.closest('[data-recent]');
      if (rc) { $('#sp-input').value = rc.dataset.recent; $('#sp-clear').hidden = false; spRun(rc.dataset.recent); return; }
      if (e.target.closest('[data-clear-recent]')) { try { localStorage.removeItem(RECENT_KEY); } catch {} spHome(); return; }
      const t = e.target.closest('.sp-tile');
      if (t && spResults.length) {
        addRecent($('#sp-input').value);
        state.items = spResults.slice();
        openViewer(state.items, Number(t.dataset.i), viewerCtx());
      }
    });
  }
  el.hidden = false;
  searchOpen = true;
  document.body.style.overflow = 'hidden';
  history.pushState({ search: 1 }, '');
  $('#sp-input').value = '';
  $('#sp-clear').hidden = true;
  spHome();
  setTimeout(() => $('#sp-input').focus(), 50);
}

function closeSearchPage(silent) {
  const el = $('#search-page');
  if (!el || !searchOpen) return;
  searchOpen = false;
  el.hidden = true;
  document.body.style.overflow = '';
  if (silent) history.replaceState(null, '');        // boshqa bo'limga o'tilyapti: belgini olib tashlaymiz
  else if (history.state?.search) history.back();    // orqaga: qidiruv yozuvini tarixdan olib tashlaymiz
}

// Android "orqaga" tugmasi va brauzer orqaga: qidiruv sahifasi yopiladi (kinoteatr ochiq bo'lsa tegmaymiz)
window.addEventListener('popstate', () => {
  if (searchOpen && !history.state?.search && !viewerOpen()) {
    const el = $('#search-page');
    searchOpen = false;
    if (el) el.hidden = true;
    document.body.style.overflow = '';
  }
});

let spResults = [];

function spHome() {
  spResults = [];
  const st = state.stats || {};
  const row = (go, ic, label, n) => `<button class="sp-row" data-sgo="${go}"><span>${icon(ic)}</span><b>${label}</b>${n ? `<i>${n}</i>` : ''}</button>`;
  const recent = getRecent();
  $('#sp-body').innerHTML = `
    <div class="sp-hint"><span>${icon('info')}</span><div>
      <b>Nima qidiryapsiz?</b>
      <small>Fayl nomini yozing, masalan «IMG_2026» yoki «video». Yoki quyidagi bo'limlardan tanlang.</small></div></div>
    <div class="sp-list">
      ${row('#/videos', 'video', 'Videolar', st.videos)}
      ${row('#/cleanup/screens', 'recent', 'Skrinshotlar')}
      ${row('#/favorites', 'star', 'Sevimlilar', st.favorites)}
      ${row('#/places', 'place', 'Joylar', st.places)}
      ${row('#/albums', 'album', 'Albomlar')}
      ${row('#/recent', 'recent', "Yaqinda qo'shilganlar")}
    </div>
    ${recent.length ? `<div class="sp-sec"><span>Yaqinda qidirilganlar</span><button data-clear-recent>Tozalash</button></div>
      <div class="sp-list">${recent.map((r) => `<button class="sp-row" data-recent="${esc(r)}"><span>${icon('search')}</span><b>${esc(r)}</b></button>`).join('')}</div>` : ''}`;
}

async function spRun(q) {
  if (!q) { spHome(); return; }
  try {
    const d = await api(`/api/media?search=${encodeURIComponent(q)}&limit=90`);
    if (!searchOpen || $('#sp-input').value.trim() !== q) return;
    spResults = d.items;
    $('#sp-body').innerHTML = d.items.length
      ? `<div class="sp-count">${d.total} ta natija</div><div class="sp-grid">${d.items.map((m, i) => `<div class="sp-tile" data-i="${i}">
          ${m.has_thumb ? `<img loading="lazy" alt="" src="./t/${m.id}">` : `<div class="fallback">${icon(m.kind === 'video' ? 'video' : 'photo')}</div>`}
          ${m.kind === 'video' ? `<span class="sp-vb">${icon('play')}</span>` : ''}</div>`).join('')}</div>`
      : `<div class="emptyview" style="padding-top:8vh">${icon('search')}<h3>Hech narsa topilmadi</h3>«${esc(q)}» bo'yicha natija yo'q.</div>`;
    hydrateIcons($('#sp-body'));
  } catch (e) { $('#sp-body').innerHTML = `<div class="emptyview"><h3>Qidirib bo'lmadi</h3>${esc(e.message)}</div>`; }
}

// (eski) tepa panelni qidiruv maydoniga aylantirish
function openMobileSearch() {
  $('#top').classList.add('searching');
  $('#search-back').innerHTML = icon('back');
  $('#search').focus();
}
function closeMobileSearch(silent) {
  if (!$('#top').classList.contains('searching')) return;
  $('#top').classList.remove('searching');
  if (!silent && state.search) { $('#search').value = ''; $('#search-clear').hidden = true; state.search = ''; reload(); }
}
$('#search-back').onclick = () => closeMobileSearch();

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
    $('#c-places').textContent = s.places || '';
    $('#c-arch').textContent = s.archive || '';
    const meter = $('#meter');
    meter.hidden = false;
    const pct = s.quota ? Math.min(100, (s.used / s.quota) * 100) : 0;
    $('#meter-fill').style.width = `${s.quota ? Math.max(pct, 1) : 0}%`;
    meter.classList.toggle('full', pct >= 90);
    $('#meter-text').textContent = s.quota ? `Band: ${bytes(s.used)} (jami ${bytes(s.quota)})` : `Band: ${bytes(s.used)}`;
  } catch {}
}
$('#more-space').onclick = () => navigate('#/plans');
// Xotira bloki (yozuv, chiziq, hajm) bosilsa: Xotirani boshqarish sahifasi
$('#meter').addEventListener('click', (e) => { if (!e.target.closest('#more-space')) navigate('#/storage'); });
$('#meter').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'meter') { e.preventDefault(); navigate('#/storage'); } });

async function loadAlbums() {
  try {
    state.albums = (await api('/api/albums')).items;
    syncNav();
    if (state.view === 'albums') renderAlbums();
    if (state.view === 'collections') renderCollections();
  } catch {}
}

function listParams(page) {
  const p = new URLSearchParams({ page, limit: 150 });
  if (state.view === 'videos') p.set('kind', 'video');
  if (state.view === 'favorites') p.set('fav', '1');
  if (state.view === 'album') p.set('album', state.albumId);
  if (state.view === 'place') p.set('place', state.place);
  if (state.view === 'recent') p.set('sort', 'added');
  if (state.view === 'archive') p.set('arch', '1');
  if (state.view === 'cleanup') { p.set('clean', state.clean); p.set('sort', 'size'); }
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
  if (state.view === 'collections') { renderCollections(); return; }
  if (state.view === 'places' && !state.search) { await renderPlaces(token); return; }
  if (state.view === 'plans') { await renderPlans(token); return; }
  if (state.view === 'storage') { await renderStorage(token); return; }
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
    if (state.view === 'place') { toast(e.message); navigate('#/places'); return; }
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
  const t = state.search ? `Qidiruv: «${esc(state.search)}»` : (state.view === 'album' || state.view === 'place' || state.view === 'photos' ? '' : TITLES[state.view]);
  let h = '';
  let warn = '';
  const q = state.user;
  if (q?.quota && q.used / q.quota >= 0.9) {
    let hidden = false;
    try { hidden = sessionStorage.getItem('dc-sw') === '1'; } catch {}
    if (!hidden) {
      warn = `<div class="storewarn"><div class="sw-t"><b>Xotirangizda joy kam (${Math.min(100, Math.round((q.used / q.quota) * 100))}% band)</b>
        <span>Joy tugagach yangi surat va videolar yuklanmaydi. Keraksiz fayllarni o'chiring yoki kengroq tarifga o'ting.</span></div>
        <div class="sw-b"><button data-act="sw-dismiss">Hozir emas</button><button class="pri" data-act="sw-plans">Tariflar</button></div></div>`;
    }
  }
  if (state.view === 'album') {
    const a = state.albums.find((x) => x.id === state.albumId);
    h = `<div class="page-head"><button class="icon-btn" data-act="back" aria-label="Orqaga">${icon('back')}</button>
      <h2>${esc(a?.name || 'Albom')}</h2><span class="sub">${state.total} ta</span><span class="grow"></span>
      <button class="icon-btn" data-act="album-menu" aria-label="Albom amallari">${icon('more')}</button></div>`;
  } else if (state.view === 'place') {
    const [la, lo] = state.place.split(',').map((x) => Number(x) / 10);
    h = `<div class="page-head"><button class="icon-btn" data-act="back-places" aria-label="Orqaga">${icon('back')}</button>
      <h2>${esc(placeName(la, lo))}</h2><span class="sub">${state.total} ta</span></div>`;
  } else if (state.view === 'cleanup') {
    h = `<div class="page-head"><button class="icon-btn" data-act="back-storage" aria-label="Orqaga">${icon('back')}</button>
      <h2>${esc(CLEAN_TITLES[state.clean])}</h2><span class="sub">${state.total} ta</span></div>
      <div class="notice">${CLEAN_HINTS[state.clean]} Keraksizlarini belgilab, tepadagi savatcha tugmasi bilan o'chiring.</div>`;
  } else if (state.view === 'archive' && !state.search) {
    h = `<div class="page-head"><h2>Arxiv</h2>${state.total ? `<span class="sub">${state.total} ta</span>` : ''}</div>
      <div class="notice">Arxivdagi suratlar «Fotolar»da ko'rinmaydi, lekin o'chmaydi. Albomlarda va qidiruvda topiladi.</div>`;
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
    case 'archive': return e('archive', "Arxiv bo'sh", "Suratni tanlab, «Arxivga» tugmasini bosing — u «Fotolar»dan yashirinadi, lekin o'chmaydi.");
    case 'recent': return e('recent', "Hali hech narsa yo'q", "Yangi yuklangan fayllar shu yerda birinchi bo'lib ko'rinadi.", up);
    case 'place': return e('place', "Bu joyda surat yo'q", '');
    case 'cleanup': return e('check', "Bu toifada fayl yo'q", "Ajoyib, bu yerda tozalaydigan hech narsa topilmadi.");
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
    const ts = state.view === 'recent' ? m.created_at : (m.taken_at || m.created_at || m.deleted_at);
    const flat = state.view === 'trash' || state.view === 'cleanup';
    const key = flat ? 'flat' : dayKey(ts);
    if (key !== lastKey) {
      lastGroup = document.createElement('div');
      lastGroup.className = 'group';
      lastGroup.dataset.key = key;
      if (flat) {
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
    if (lastBlock && !flat) {   // blok kengligi = bir qatordagi surat kengliklari yig'indisi
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
        + (state.view === 'archive' ? btn('unarchive', 'unarchive', 'Arxivdan chiqarish') : btn('archive', 'archive', 'Arxivga'))
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
    } else if (a === 'archive' || a === 'unarchive') {
      await bulk(a, ids);
      removeLocal(ids);
      toast(a === 'archive' ? `${ids.length} ta fayl arxivga o'tkazildi` : `${ids.length} ta fayl arxivdan chiqarildi`);
      loadStats();
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
    archived: state.view === 'archive',
    archive: async (m) => {
      const to = state.view === 'archive' ? 'unarchive' : 'archive';
      await bulk(to, [m.id]); removeLocal([m.id]);
      toast(to === 'archive' ? 'Arxivga o\'tkazildi' : 'Arxivdan chiqarildi'); loadStats();
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

// ── Xotirani boshqarish ───────────────────────────────────────────
let storageData = null;

async function renderStorage(token) {
  disconnectObserver();
  syncNav();
  main.innerHTML = '<div class="loading">Yuklanmoqda…</div>';
  try { storageData = await api('/api/storage'); } catch (e) { toast(e.message); return; }
  if (token !== state.token) return;
  drawStorage();
}

function drawStorage() {
  const d = storageData;
  const free = d.quota ? Math.max(0, d.quota - d.used) : null;
  const pct = d.quota ? Math.round((d.used / d.quota) * 100) : 0;
  const seg = (x, c) => (d.quota && x ? `<i style="width:${Math.min(100, (x / d.quota) * 100)}%;background:${c}"></i>` : '');
  const lg = (c, label, x) => `<div class="lg"><i style="background:${c}"></i><span>${label} (${bytes(x.bytes)})</span></div>`;
  const cl = d.cleanup || {};
  const item = (go, ic, label, x, sub) => `<button class="st-item" data-go="${go}"><span class="st-ic">${icon(ic)}</span>
    <div><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div><em>${x && x.n ? bytes(x.bytes) : '~0 MB'}</em></button>`;
  main.innerHTML = `<div class="storage">
    <h2 class="st-title">${free != null ? `Bo'sh: ${bytes(free)}` : 'Xotira'}</h2>
    ${pct >= 90 ? `<p class="st-warn">Tez orada yangi surat va videolarni saqlab bo'lmaydi. Keraksiz fayllarni o'chiring yoki kengroq tarifga o'ting.</p>` : '<p class="st-sub">Xotirangiz yetarli. Joyni tejash uchun quyidagi tavsiyalardan foydalaning.</p>'}
    ${d.quota ? `<div class="st-bar ${pct >= 90 ? 'warn' : ''}">${seg(d.images.bytes, '#ea4335')}${seg(d.videos.bytes, '#f28b82')}${seg(d.trash.bytes, '#fbbc04')}</div>` : ''}
    <div class="st-legend-row">
      <div class="st-legend">${lg('#ea4335', 'Suratlar', d.images)}${lg('#f28b82', 'Videolar', d.videos)}${lg('#fbbc04', 'Savatcha', d.trash)}</div>
      <div class="st-used">${d.quota ? `Band: ${bytes(d.used)} / ${bytes(d.quota)}` : `Band: ${bytes(d.used)}`}</div>
    </div>
    <div class="st-banner"><div><b>Ko'proq joy — ko'proq xotira</b><span>Kengroq tarifga o'ting: 500 GB dan 5 TB gacha, arzon narxlarda.</span></div><button class="btn sm st-link" data-go="#/plans">Tariflarni ko'rish</button></div>
    <h3 class="st-h">Keraksiz fayllarni o'chiring</h3>
    <div class="st-items">
      ${item('#/cleanup/large', 'photo', 'Katta hajmli surat va videolar', cl.large, cl.large?.n ? `${cl.large.n} ta fayl` : '')}
      ${item('#/cleanup/dupes', 'album', 'Takroriy fayllar', cl.dupes, cl.dupes?.n ? `${cl.dupes.n} ta nusxa` : '')}
      ${item('#/cleanup/screens', 'recent', 'Skrinshotlar', cl.screens, cl.screens?.n ? `${cl.screens.n} ta fayl` : '')}
      ${item('#/cleanup/unsupported', 'video', "Brauzerda ochilmaydigan videolar", cl.unsupported, cl.unsupported?.n ? `${cl.unsupported.n} ta fayl` : '')}
    </div>
    <h3 class="st-h">Boshqa takliflar</h3>
    <div class="st-items">
      ${item('#/trash', 'delete', "Savatchani bo'shating", d.trash, d.trash.n ? `${d.trash.n} ta fayl savatchada. Ular hajmingizdan hisoblanadi.` : '')}
      ${item('#/archive', 'archive', 'Arxivni ko\'rib chiqing', d.archive, d.archive.n ? `${d.archive.n} ta fayl` : '')}
    </div>
  </div>`;
  hydrateIcons(main);
}

main.addEventListener('click', async (e) => {
  if (state.view !== 'storage' || !storageData) return;
  const del = e.target.closest('[data-del]');
  const row = e.target.closest('.st-row');
  if (del) {
    try {
      await bulk('trash', [del.dataset.del]);
      toast('Savatchaga olindi (joy savatcha tozalanganda bo\'shaydi)');
      await Promise.all([loadStats(), renderStorage(state.token)]);
    } catch (err) { toast(err.message); }
  } else if (row) {
    state.items = storageData.largest.slice();
    openViewer(state.items, Number(row.dataset.i), { ...viewerCtx(), closed: () => { if (state.view === 'storage') renderStorage(state.token); } });
  }
});

// ── To'plamlar (telefonda asosiy bo'limlar) ───────────────────────
function renderCollections() {
  disconnectObserver();
  syncNav();
  const st = state.stats || {};
  const q = state.user || {};
  const pct = q.quota ? Math.min(100, (q.used / q.quota) * 100) : 0;
  const chip = (go, ic, label, n) => `<button class="chip" data-go="#/${go}"><span>${icon(ic)}</span><b>${label}</b>${n ? `<i>${n}</i>` : ''}</button>`;
  main.innerHTML = `<div class="coll">
    <div class="chips">
      ${chip('videos', 'video', 'Videolar', st.videos)}
      ${chip('favorites', 'star', 'Sevimlilar', st.favorites)}
      ${chip('places', 'place', 'Joylar', st.places)}
      ${chip('recent', 'recent', "Yaqinda qo'shilgan")}
      ${chip('archive', 'archive', 'Arxiv', st.archive)}
      ${chip('trash', 'delete', 'Savatcha', st.trash)}
    </div>
    <h3 class="coll-h">Albomlar</h3>
    <div class="albums">
      <div class="album new" data-act="new-album"><div class="cover">${icon('add')}</div><div class="nm">Yangi albom</div></div>
      ${state.albums.map((a) => `<div class="album" data-album="${esc(a.id)}">
        <div class="cover">${a.cover ? `<img loading="lazy" alt="" src="./t/${a.cover}">` : `<div class="fallback">${icon('album')}</div>`}</div>
        <div class="nm">${esc(a.name)}</div><div class="ct">${a.n} ta</div></div>`).join('')}
    </div>
    <h3 class="coll-h">Xotira</h3>
    <div class="coll-store">
      <div class="bar"><i style="width:${q.quota ? Math.max(pct, 1) : 0}%"></i></div>
      <div>${q.quota ? `Band: ${bytes(q.used || 0)} (jami ${bytes(q.quota)})` : `Band: ${bytes(q.used || 0)}`}</div>
      <button class="btn sm" data-go="#/plans">Tariflar</button>
    </div>
  </div>`;
  hydrateIcons(main);
}
main.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) navigate(g.dataset.go); });

// ── Tariflar ──────────────────────────────────────────────────────
const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const fmtGb = (gb) => (gb >= 1000 ? `${+(gb / 1000).toFixed(1)} TB` : `${gb} GB`);
let plansData = null;
let plansYearly = false;

async function renderPlans(token) {
  disconnectObserver();
  syncNav();
  if (!plansData) {
    main.innerHTML = '<div class="loading">Yuklanmoqda…</div>';
    try { plansData = await api('/api/plans'); } catch (e) { toast(e.message); return; }
    if (token !== state.token) return;
  }
  drawPlans();
}

// Har bir tarifga o'z rangi (Google logotipi ranglari): [asosiy, ikkinchi]
const PLAN_COLORS = {
  free: ['#34a853', '#7fd69a'],
  p100: ['#1a73e8', '#5fb0ff'],
  p500: ['#7c4dff', '#e040fb'],
  p2000: ['#f9ab00', '#ff7043'],
  p5000: ['#ea4335', '#ff6f91'],
};
const PLAN_FALLBACK = [['#1a73e8', '#5fb0ff'], ['#7c4dff', '#e040fb'], ['#f9ab00', '#ff7043'], ['#ea4335', '#ff6f91'], ['#34a853', '#7fd69a']];

function drawPlans() {
  const d = plansData;
  const curGb = state.user?.quota ? Math.round(state.user.quota / 1024 ** 3) : null;
  const price = (p) => (plansYearly ? (p.monthly * d.yearlyMonths) / 12 : p.monthly);
  const save = Math.round((1 - d.yearlyMonths / 12) * 100);
  main.innerHTML = `
    <div class="plans-head"><h2>O'zingizga mos tarifni tanlang</h2>
      <p>Hajm kerak bo'lsa tarifni oshiring. Istalgan vaqtda o'zgartirish mumkin.</p>
      <div class="seg" id="plan-seg"><button data-y="0" class="${plansYearly ? '' : 'on'}">Oyiga</button><button data-y="1" class="${plansYearly ? 'on' : ''}">Yiliga</button></div>
      ${plansYearly && save > 0 ? `<div class="plans-save"><span>Yillik to'lovda ${save}% tejaysiz</span></div>` : '<div class="plans-save">&nbsp;</div>'}
    </div>
    <div class="plans">${d.plans.map((p, i) => {
      const cur = curGb === p.gb;
      const pr = price(p);
      const [c1, c2] = PLAN_COLORS[p.id] || PLAN_FALLBACK[i % PLAN_FALLBACK.length];
      return `<div class="plan${p.recommended ? ' rec' : ''}${cur ? ' cur' : ''}" style="--pc:${c1};--pc2:${c2}">
        ${p.recommended ? '<div class="plan-tag">★ Tavsiya etiladi</div>' : ''}
        <div class="plan-top">
          <div class="plan-ic">${icon('cloud')}</div>
          <div class="plan-gb">${fmtGb(p.gb)}</div>
          <h3>${esc(p.name)}</h3>
        </div>
        <div class="plan-body">
          <div class="plan-price">${p.monthly ? `<b>${fmtNum(pr)}</b> <span>${esc(d.currency)} / oyiga</span>` : '<b>Bepul</b>'}</div>
          <div class="plan-sub">${p.monthly ? (plansYearly ? `Yiliga ${fmtNum(p.monthly * d.yearlyMonths)} ${esc(d.currency)}` : "Har oy to'lanadi") : "Ro'yxatdan o'tganda beriladi"}</div>
          ${p.google ? `<div class="plan-cmp">Google'da shu hajm: <s>${fmtNum(p.google)} ${esc(d.currency)}</s> / oyiga</div>` : '<div class="plan-cmp">&nbsp;</div>'}
          <button class="btn plan-btn" data-plan="${esc(p.id)}" ${cur || !p.monthly ? 'disabled' : ''}>${cur ? '✓ Joriy tarif' : (p.monthly ? 'Tanlash' : 'Bepul')}</button>
          <ul><li>${fmtGb(p.gb)} surat va video uchun joy</li><li>Fayllar soni cheklanmagan</li><li>Albomlar va ulashish havolalari</li><li>Shifrlangan saqlash</li></ul>
        </div>
      </div>`;
    }).join('')}</div>`;
  hydrateIcons(main);
}

main.addEventListener('click', (e) => {
  const seg = e.target.closest('#plan-seg button');
  if (seg && plansData) { plansYearly = seg.dataset.y === '1'; drawPlans(); return; }
  const pb = e.target.closest('button[data-plan]');
  if (!pb || !plansData) return;
  const p = plansData.plans.find((x) => x.id === pb.dataset.plan);
  if (!p) return;
  const total = plansYearly ? p.monthly * plansData.yearlyMonths : p.monthly;
  const m = modal(`
    <h2>«${esc(p.name)}» — ${fmtGb(p.gb)}</h2>
    <div style="line-height:1.6">To'lov: <b>${fmtNum(total)} ${esc(plansData.currency)}</b> ${plansYearly ? 'yiliga' : 'oyiga'}.</div>
    <div style="color:var(--muted);font-size:13px;line-height:1.55">Hozircha to'lov administrator orqali qabul qilinadi. To'lovdan keyin hajmingiz oshiriladi.
      ${plansData.contact ? `<br><br>Bog'lanish: <b>${esc(plansData.contact)}</b><br>Murojaatda hisobingiz loginini yozing: <b>${esc(state.user.username)}</b>` : '<br><br>Administrator bilan bog\'laning.'}</div>
    <div class="actions">${plansData.contact ? '<button class="btn" data-x="copy">Loginni nusxalash</button>' : ''}<button class="btn primary" data-x="ok">Yopish</button></div>`);
  $('[data-x="ok"]', m).onclick = () => m.close();
  const cp = $('[data-x="copy"]', m);
  if (cp) cp.onclick = () => copyText(state.user.username).then(() => toast('Nusxalandi'));
});

// ── Joylar ro'yxati ───────────────────────────────────────────────
async function renderPlaces(token) {
  disconnectObserver();
  syncNav();
  main.innerHTML = '<div class="loading">Yuklanmoqda…</div>';
  let items = [];
  try { items = (await api('/api/places')).items; } catch (e) { toast(e.message); }
  if (token !== state.token) return;
  main.innerHTML = `<div class="page-head"><h2>Joylar</h2></div>` + (items.length
    ? `<div class="albums">${items.map((p) => `<div class="album" data-place="${p.la},${p.lo}">
        <div class="cover">${p.cover ? `<img loading="lazy" alt="" src="./t/${p.cover}">` : `<div class="fallback">${icon('place')}</div>`}</div>
        <div class="nm">${esc(placeName(p.lat, p.lon))}</div><div class="ct">${p.n} ta</div></div>`).join('')}</div>`
    : `<div class="emptyview">${icon('place')}<h3>Joylar yo'q</h3>Telefon yoki kamerada joylashuv yoqilgan holda olingan suratlar shu yerda joyi bo'yicha to'planadi.</div>`);
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
    else if (act === 'back-places') navigate('#/places');
    else if (act === 'back-storage') navigate('#/storage');
    else if (act === 'sw-dismiss') { try { sessionStorage.setItem('dc-sw', '1'); } catch {} e.target.closest('.storewarn')?.remove(); }
    else if (act === 'sw-plans') navigate('#/plans');
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
  const pl = e.target.closest('.album[data-place]');
  if (pl) navigate(`#/place/${pl.dataset.place}`);
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
    if (['albums', 'trash', 'collections', 'plans', 'storage'].includes(state.view)) { navigate('#/photos'); return; }
    reload();
  }, 300);
});
$('#search-clear').onclick = () => { $('#search').value = ''; $('#search-clear').hidden = true; state.search = ''; reload(); };

// ── Yuklash tugmalari ─────────────────────────────────────────────
$('#fab').onclick = () => $('#file').click();
$('#upload-icon').onclick = () => $('#file').click();
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
// ── Tepa panel: yuklash (+), yordam, sozlamalar, bo'limlar, hisob ─────
const THEMES = [['auto', 'Avto'], ['light', "Yorug'"], ['dark', "Qorong'i"]];
const curTheme = () => { try { return localStorage.getItem('dc-theme') || 'auto'; } catch { return 'auto'; } };
function setTheme(t) {
  try { t === 'auto' ? localStorage.removeItem('dc-theme') : localStorage.setItem('dc-theme', t); } catch {}
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}

$('#plus-btn').onclick = (e) => {
  const m = openMenu(e.currentTarget, `
    <button data-m="up">${icon('upload')}Fayllarni yuklash</button>
    <button data-m="album">${icon('album')}Yangi albom</button>`);
  m.addEventListener('click', (ev) => {
    const k = ev.target.closest('[data-m]')?.dataset.m;
    if (k === 'up') $('#file').click();
    else if (k === 'album') handleAct('new-album', ev);
  });
};

$('#help-btn').onclick = async () => {
  let contact = '';
  try { contact = (await fetch('/api/config').then((r) => r.json())).contact || ''; } catch {}
  const row = (ic, t, d) => `<div class="help-row"><span>${icon(ic)}</span><div><b>${t}</b><small>${d}</small></div></div>`;
  const m = modal(`
    <h2>Yordam</h2>
    <div class="help">
      ${row('upload', 'Yuklash', "«+» tugmasini bosing yoki suratlarni oynaga sudrab tashlang. Katta videolar ham bo'laklab yuklanadi, uzilsa davom etadi.")}
      ${row('check', 'Tanlash', "Surat ustidagi doirani bosing. Shift tugmasi bilan oraliqni tanlash mumkin.")}
      ${row('share', 'Ulashish', "Suratni oching → «Ulashish». Havola bor odam kirmasdan ko'ra oladi. Muddatini o'zingiz belgilaysiz.")}
      ${row('delete', 'Savatcha', "O'chirilgan fayllar 30 kun saqlanadi, keyin butunlay o'chadi. Joy savatchada ham band bo'ladi.")}
      ${row('archive', 'Arxiv', "Kerak bo'lmagan suratlarni «Fotolar»dan yashiradi, lekin o'chirmaydi.")}
      ${row('cloud', 'Xotira', "Joy to'lib qolsa «Xotirani boshqarish» da eng katta fayllarni ko'rib, keraksizini o'chirishingiz mumkin.")}
    </div>
    ${contact ? `<div class="help-contact">Savol bo'lsa: <b>${esc(contact)}</b></div>` : ''}
    <div class="help-links"><a href="/privacy" target="_blank">Maxfiylik siyosati</a> · <a href="/terms" target="_blank">Foydalanish shartlari</a></div>
    <div class="actions"><button class="btn primary" data-x="ok">Yopish</button></div>`);
  $('[data-x="ok"]', m).onclick = () => m.close();
};

$('#gear-btn').onclick = (e) => {
  const t = curTheme();
  const m = openMenu(e.currentTarget, `
    <div class="head"><b>Sozlamalar</b></div>
    <div class="menu-sec">Mavzu</div>
    <div class="seg theme-seg">${THEMES.map(([k, n]) => `<button data-theme="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <hr>
    <button data-go="#/storage">${icon('cloud')}Xotirani boshqarish</button>
    <button data-go="#/plans">${icon('star')}Tariflar</button>
    ${window.DezoApp ? `<button data-m="backup">${icon('upload')}Telefon zaxirasi</button>` : ''}
    ${state.user.hasPassword === false ? '' : `<button data-m="pw">${icon('lock')}Parolni o'zgartirish</button>`}`, 'wide');
  m.addEventListener('click', (ev) => {
    const th = ev.target.closest('[data-theme]');
    if (th) { setTheme(th.dataset.theme); $$('.theme-seg button', m).forEach((x) => x.classList.toggle('on', x === th)); ev.stopPropagation(); return; }
    if (ev.target.closest('[data-m="pw"]')) passwordDialog();
    if (ev.target.closest('[data-m="backup"]')) window.DezoApp?.openBackupSettings();
    const g = ev.target.closest('[data-go]');
    if (g) navigate(g.dataset.go);
  }, true);
};

$('#apps-btn').onclick = (e) => {
  const st = state.stats || {};
  const tile = (go, ic, label, c, n) => `<button class="app-tile" data-go="${go}" style="--ac:${c}"><span>${icon(ic)}</span><b>${label}</b>${n ? `<i>${n}</i>` : ''}</button>`;
  const m = openMenu(e.currentTarget, `
    <div class="apps-grid">
      ${tile('#/photos', 'photo', 'Fotolar', '#4285f4', st.total)}
      ${tile('#/albums', 'album', 'Albomlar', '#34a853')}
      ${tile('#/videos', 'video', 'Videolar', '#ea4335', st.videos)}
      ${tile('#/favorites', 'star', 'Sevimlilar', '#fbbc04', st.favorites)}
      ${tile('#/places', 'place', 'Joylar', '#9b5cf6', st.places)}
      ${tile('#/recent', 'recent', 'Yaqinda', '#00acc1')}
      ${tile('#/archive', 'archive', 'Arxiv', '#6d7a8a', st.archive)}
      ${tile('#/trash', 'delete', 'Savatcha', '#ef6c00', st.trash)}
      ${tile('#/storage', 'cloud', 'Xotira', '#1a73e8')}
      ${tile('#/plans', 'star', 'Tariflar', '#e040fb')}
      ${state.user.role === 'admin' ? `<a class="app-tile" href="/admin" style="--ac:#455a64"><span>${icon('shield')}</span><b>Admin</b></a>` : ''}
    </div>`, 'apps');
  m.addEventListener('click', (ev) => { const g = ev.target.closest('[data-go]'); if (g) navigate(g.dataset.go); });
};

$('#avatar').onclick = (e) => {
  const u = state.user;
  const full = u.quota ? Math.min(100, (u.used / u.quota) * 100) : 0;
  const m = openMenu(e.currentTarget, `
    <div class="acc-head">
      <div class="acc-av">${esc(u.username[0] || '?')}</div>
      <div class="acc-id"><b>${esc(u.username)}</b>${u.email ? `<span>${esc(u.email)}</span>` : ''}</div>
    </div>
    <div class="acc-store ${full >= 90 ? 'warn' : ''}">
      <div class="acc-row"><span>${icon('cloud')}</span><b>${u.quota ? `Band: ${Math.round(full)}% (${bytes(u.used)} / ${bytes(u.quota)})` : `Band: ${bytes(u.used)}`}</b></div>
      ${u.quota ? `<div class="bar"><i style="width:${Math.max(full, 1)}%"></i></div>` : ''}
      <div class="acc-btns"><button data-go="#/plans">Joy sotib olish</button><button data-go="#/storage">Joy bo'shatish</button></div>
    </div>
    ${window.DezoApp ? `<button data-m="backup">${icon('upload')}Telefon zaxirasi</button>` : ''}
    ${u.hasPassword === false ? '' : `<button data-m="pw">${icon('lock')}Parolni o'zgartirish</button>`}
    ${u.role === 'admin' ? `<a href="./admin.html">${icon('shield')}Administrator paneli</a>` : ''}
    <button data-m="out">${icon('logout')}Chiqish</button>
    <div class="acc-foot"><a href="/privacy" target="_blank">Maxfiylik</a> · <a href="/terms" target="_blank">Shartlar</a></div>`, 'account');
  m.addEventListener('click', async (ev) => {
    const g = ev.target.closest('[data-go]');
    if (g) { navigate(g.dataset.go); return; }
    const k = ev.target.closest('[data-m]')?.dataset.m;
    if (k === 'out') {
      if (hasActive() && !(await confirmBox({ title: 'Chiqishni xohlaysizmi?', text: "Yuklash hali tugamagan, chiqsangiz to'xtaydi.", ok: 'Chiqish' }))) return;
      await fetch('/api/logout', { method: 'POST' });
      location.href = './login.html';
    } else if (k === 'pw') passwordDialog();
    else if (k === 'backup') window.DezoApp?.openBackupSettings();
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
