// To'liq ekranli ko'rish oynasi: surat/video, qo'shni fayllarga o'tish, ma'lumot paneli.
import { icon, esc, bytes, duration, fullDate, hydrateIcons, $ } from './util.js';

let root = null;
let st = null;   // { list, i, ctx, info, pushed, idleTimer, loadToken }

export const isOpen = () => !!root;

/**
 * list — ko'rsatiladigan fayllar (asosiy ro'yxatning o'zi: o'zgarsa, shu yerda ham o'zgaradi)
 * ctx  — { trash: bool, favorite(item), trashIt(item), restore(item), purge(item), share(item), album(item) }
 *        har bir amal ro'yxatdan o'chirsa, ro'yxatni o'zgartiradi va Promise qaytaradi.
 */
export function openViewer(list, index, ctx) {
  if (root) closeNow();
  st = { list, i: index, ctx, info: false, pushed: false, idleTimer: null, token: 0 };

  root = document.createElement('div');
  root.className = 'viewer';
  root.innerHTML = `
    <div class="vtop">
      <button class="icon-btn" data-a="close" aria-label="Yopish">${icon('back')}</button>
      <div class="vtitle"><b id="v-name"></b><span id="v-date"></span></div>
      <span id="v-actions" style="display:flex"></span>
    </div>
    <div class="vstage" id="v-stage"></div>
    <button class="vnav prev" data-a="prev" aria-label="Oldingisi">${icon('left')}</button>
    <button class="vnav next" data-a="next" aria-label="Keyingisi">${icon('right')}</button>
    <div id="v-info" class="vinfo" hidden></div>`;
  document.getElementById('overlay-root').appendChild(root);
  document.body.style.overflow = 'hidden';

  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  root.addEventListener('mousemove', wake);
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchend', onTouchEnd, { passive: true });

  history.pushState({ viewer: 1 }, '');
  st.pushed = true;
  show();
  wake();
}

function item() { return st.list[st.i]; }

function actionsHtml(m) {
  const b = (a, ic, label, on = false) => `<button class="icon-btn${on ? ' on' : ''}" data-a="${a}" aria-label="${label}" title="${label}" ${on ? 'style="color:#8ab4f8"' : ''}>${icon(ic)}</button>`;
  if (st.ctx.trash) {
    return b('restore', 'restore', 'Tiklash') + b('download', 'download', 'Yuklab olish') + b('info', 'info', "Ma'lumot") + b('purge', 'delete', "Butunlay o'chirish");
  }
  return b('fav', m.favorite ? 'star' : 'starOutline', m.favorite ? 'Sevimlilardan olish' : 'Sevimlilarga', !!m.favorite)
    + b('share', 'share', 'Ulashish') + b('download', 'download', 'Yuklab olish')
    + b('album', 'album', "Albomga qo'shish") + b('info', 'info', "Ma'lumot") + b('trash', 'delete', 'Savatchaga');
}

function show() {
  const m = item();
  if (!m) return closeNow();
  const token = ++st.token;

  $('#v-name', root).textContent = m.name;
  $('#v-date', root).textContent = fullDate(m.taken_at || m.created_at);
  $('#v-actions', root).innerHTML = actionsHtml(m);
  $('.vnav.prev', root).hidden = st.i <= 0;
  $('.vnav.next', root).hidden = st.i >= st.list.length - 1;
  if (st.info) renderInfo();

  const stage = $('#v-stage', root);
  stage.innerHTML = '';

  if (m.kind === 'video') {
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true;
    if (m.has_thumb) v.poster = `./t/${m.id}`;
    v.src = `./f/${m.id}`;
    v.onerror = () => { if (token === st.token) stage.innerHTML = `<div class="vmsg">Namoyish (demo) rejimida video ijro etilmaydi.</div>`; };
    stage.appendChild(v);
    return;
  }

  // Rasm: avval kichik eskiz (xira), keyin asl rasm
  const spin = document.createElement('div');
  spin.className = 'vspin';
  if (m.has_thumb) {
    const t = document.createElement('img');
    t.className = 'blur'; t.src = `./t/${m.id}`; t.alt = '';
    stage.appendChild(t);
  }
  stage.appendChild(spin);

  const full = new Image();
  full.alt = m.name;
  full.onload = () => {
    if (token !== st.token) return;
    stage.innerHTML = '';
    stage.appendChild(full);
    preload(st.i + 1); preload(st.i - 1);
  };
  full.onerror = () => {
    if (token !== st.token) return;
    stage.innerHTML = `<div class="vmsg">Bu format (${esc(m.mime)}) brauzerda ko'rsatilmaydi.<br>Yuklab olib oching.</div>`;
  };
  full.src = `./f/${m.id}`;
}

function preload(i) {
  const m = st.list[i];
  if (m && m.kind === 'image') { const im = new Image(); im.src = `./f/${m.id}`; }
}

function renderInfo() {
  const m = item();
  const box = $('#v-info', root);
  box.hidden = !st.info;
  if (!st.info || !m) return;
  const dims = m.width && m.height ? `${m.width} × ${m.height}` : '—';
  box.innerHTML = `
    <h3><button class="icon-btn" data-a="info" aria-label="Yopish">${icon('close')}</button>Ma'lumot</h3>
    <dl>
      <div><dt>Nomi</dt><dd>${esc(m.name)}</dd></div>
      <div><dt>Sana</dt><dd>${esc(fullDate(m.taken_at || m.created_at))}</dd></div>
      <div><dt>Hajmi</dt><dd>${bytes(m.size)}</dd></div>
      <div><dt>O'lchami</dt><dd>${dims}</dd></div>
      ${m.duration ? `<div><dt>Davomiyligi</dt><dd>${duration(m.duration)}</dd></div>` : ''}
      <div><dt>Turi</dt><dd>${esc(m.mime)}</dd></div>
      <div><dt>Yuklangan</dt><dd>${esc(fullDate(m.created_at))}</dd></div>
    </dl>`;
}

function go(d) {
  const n = st.i + d;
  if (n < 0 || n >= st.list.length) return;
  st.i = n;
  show();
}

async function act(a) {
  const m = item();
  const c = st.ctx;
  try {
    switch (a) {
      case 'close': return close();
      case 'prev': return go(-1);
      case 'next': return go(1);
      case 'info': st.info = !st.info; return renderInfo();
      case 'download': { const l = document.createElement('a'); l.href = `./f/${m.id}?dl=1`; l.download = m.name; document.body.appendChild(l); l.click(); l.remove(); return; }
      case 'fav': await c.favorite(m); return show();
      case 'share': return c.share(m);
      case 'album': return c.album(m);
      case 'trash': await c.trashIt(m); return afterRemoval();
      case 'restore': await c.restore(m); return afterRemoval();
      case 'purge': if (await c.purge(m)) return afterRemoval(); return;
    }
  } catch { /* xabarni chaqiruvchi ko'rsatgan */ }
}

function afterRemoval() {
  if (!st.list.length) return close();
  if (st.i >= st.list.length) st.i = st.list.length - 1;
  show();
}

function onClick(e) {
  const b = e.target.closest('[data-a]');
  if (b) return act(b.dataset.a);
  // Rasm ustiga bosish: boshqaruv elementlarini yashirish/ko'rsatish (telefonda qulay)
  if (e.target.closest('#v-stage') && e.target.tagName !== 'VIDEO') root.classList.toggle('idle');
}

function onKey(e) {
  if (!root || document.querySelector('.modal-back')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (st.info) { st.info = false; renderInfo(); } else close(); }
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'i' || e.key === 'I') act('info');
  else if (e.key === 'Delete' && !st.ctx.trash) act('trash');
  else return;
  wake();
}

let tx = 0, ty = 0;
function onTouchStart(e) { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }
function onTouchEnd(e) {
  if (!st || e.changedTouches.length !== 1 || e.target.tagName === 'VIDEO') return;
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) close();   // pastga surib yopish
}

function wake() {
  if (!root) return;
  root.classList.remove('idle');
  clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => { if (root && !st.info && matchMedia('(hover: hover)').matches) root.classList.add('idle'); }, 3000);
}

function onPop() { if (root) { st.pushed = false; closeNow(); } }

export function close() {
  if (!root) return;
  if (st.pushed && history.state?.viewer) { st.pushed = false; history.back(); }   // popstate yopadi
  else closeNow();
}

function closeNow() {
  if (!root) return;
  clearTimeout(st.idleTimer);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('popstate', onPop);
  root.querySelector('video')?.pause();
  root.remove();
  root = null;
  document.body.style.overflow = '';
  const done = st?.ctx?.closed;
  st = null;
  done?.();
}

/** Ro'yxat tashqaridan o'zgarganda (masalan yangi yuklash) ko'rinishni yangilaydi. */
export function refreshViewer() { if (root) show(); }
