// Yuklash: eskiz yasash, 8 MB bo'laklab yuborish, uzilsa davom ettirish.
import { icon, esc, bytes, toast, $, hydrateIcons } from './util.js';

const ALLOWED = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|mp4|m4v|mov|webm|mkv|avi|3gp|mts|m2ts|mpe?g|wmv)$/i;
const CHUNK = 8 * 1024 * 1024;
const CONCURRENCY = 2;
const MAX_RETRY = 8;

let hooks = { onProgressDone: () => {}, onAllDone: () => {}, getAlbum: () => null };
let panel = null;
const queue = [];
let running = 0;
let total = 0, finished = 0, failed = 0;

export function initUploader(h) { hooks = { ...hooks, ...h }; }
export const hasActive = () => running > 0 || queue.length > 0;

/** Foydalanuvchi tanlagan fayllarni navbatga qo'yadi. Ruxsat etilmaganlarini hisoblab xabar beradi. */
export function enqueue(fileList, { maxFileSize = Infinity } = {}) {
  const files = [...fileList];
  const ok = files.filter((f) => ALLOWED.test(f.name));
  const skipped = files.length - ok.length;
  if (skipped) toast(`${skipped} ta fayl o'tkazib yuborildi: faqat surat va video yuklash mumkin`, 5000);
  if (!ok.length) return;

  ensurePanel();
  const album = hooks.getAlbum();
  for (const file of ok) {
    const it = { file, album, row: makeRow(file), ac: null, cancelled: false };
    if (file.size > maxFileSize) { setRow(it, { err: `Juda katta (${bytes(file.size)}). Chegara: ${bytes(maxFileSize)}` }); failed++; total++; continue; }
    total++;
    queue.push(it);
  }
  refreshHeader();
  pump();
}

// ── Panel ─────────────────────────────────────────────────────────
function ensurePanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.className = 'upanel';
  panel.innerHTML = `
    <div class="uh"><span class="t" id="up-title"></span>
      <button class="icon-btn" id="up-min" aria-label="Kichraytirish"></button>
      <button class="icon-btn" id="up-x" aria-label="Yopish" hidden></button></div>
    <div class="ul" id="up-list"></div>`;
  document.body.appendChild(panel);
  $('#up-min', panel).innerHTML = icon('remove');
  $('#up-x', panel).innerHTML = icon('close');
  $('#up-min', panel).onclick = () => panel.classList.toggle('min');
  $('#up-x', panel).onclick = () => { panel.remove(); panel = null; total = finished = failed = 0; };
}

function refreshHeader() {
  if (!panel) return;
  const active = hasActive();
  const t = $('#up-title', panel);
  if (active) t.textContent = `Yuklanmoqda: ${finished + failed}/${total}`;
  else t.textContent = failed ? `${finished} ta yuklandi, ${failed} tasi xato` : `${finished} ta fayl yuklandi`;
  $('#up-x', panel).hidden = active;
}

function makeRow(file) {
  const row = document.createElement('div');
  row.className = 'urow';
  row.innerHTML = `<div class="n">${esc(file.name)}</div><button class="icon-btn x" aria-label="Bekor qilish" style="width:32px;height:32px"></button>
    <div class="s">Navbatda · ${bytes(file.size)}</div><div class="bar"><i></i></div>`;
  $('.x', row).innerHTML = icon('close');
  $('#up-list', panel).appendChild(row);
  return row;
}

function setRow(it, { pct, text, err, done }) {
  const r = it.row;
  if (pct != null) $('.bar i', r).style.width = `${pct}%`;
  if (text != null) $('.s', r).textContent = text;
  if (err) { r.classList.add('err'); $('.s', r).textContent = err; $('.x', r).hidden = true; }
  if (done) { r.classList.add('done'); $('.bar i', r).style.width = '100%'; $('.x', r).hidden = true; }
}

// ── Navbat ────────────────────────────────────────────────────────
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const it = queue.shift();
    if (it.cancelled) continue;
    running++;
    $('.x', it.row).onclick = () => cancel(it);
    run(it).finally(() => {
      running--;
      refreshHeader();
      if (!hasActive()) hooks.onAllDone({ ok: finished, bad: failed });
      pump();
    });
  }
}

async function cancel(it) {
  it.cancelled = true;
  it.ac?.abort();
  setRow(it, { err: 'Bekor qilindi' });
  const i = queue.indexOf(it);
  if (i >= 0) { queue.splice(i, 1); failed++; total = Math.max(total, finished + failed); refreshHeader(); }
  if (it.uploadId) fetch(`/api/upload?uploadId=${it.uploadId}`, { method: 'DELETE' }).catch(() => {});
}

async function run(it) {
  try {
    await upload(it);
    finished++;
    setRow(it, { done: true, text: `Yuklandi · ${bytes(it.file.size)}` });
    hooks.onProgressDone();
  } catch (e) {
    failed++;
    if (!it.cancelled) setRow(it, { err: e.message });
  }
}

// ── Eskiz (thumbnail) va o'lcham ──────────────────────────────────
function shrink(source, w, h) {
  const scale = Math.min(1, 480 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

async function probeImage(file) {
  try {
    const bmp = await createImageBitmap(file);   // EXIF burilishini hisobga oladi
    const out = { width: bmp.width, height: bmp.height, thumb: shrink(bmp, bmp.width, bmp.height) };
    bmp.close?.();
    return out;
  } catch {
    return {};   // HEIC kabi brauzer ocha olmaydigan format: eskizsiz saqlanadi
  }
}

function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    let settled = false;
    const done = (out) => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(out); };
    const timer = setTimeout(() => done({}), 12000);
    v.onerror = () => done({});
    v.onloadedmetadata = () => {
      const info = { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : undefined };
      v.onseeked = () => {
        try { done({ ...info, thumb: shrink(v, v.videoWidth, v.videoHeight) }); } catch { done(info); }
      };
      try { v.currentTime = Math.min(1, (v.duration || 2) / 3); } catch { done(info); }
    };
    v.src = url;
  });
}

const probe = (file) => (/\.(mp4|m4v|mov|webm|mkv|avi|3gp|mts|m2ts|mpe?g|wmv)$/i.test(file.name) ? probeVideo(file) : probeImage(file));

// ── Yuborish ──────────────────────────────────────────────────────
function stableUploadId(file) {
  const raw = `${file.name}|${file.size}|${file.lastModified}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return 'u' + h.toString(36) + '_' + file.size.toString(36);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Fatal extends Error {}

async function readJson(r) { return r.json().catch(() => ({})); }

async function upload(it) {
  const { file } = it;
  const uploadId = (it.uploadId = stableUploadId(file));
  setRow(it, { text: 'Tayyorlanmoqda...' });
  const meta = await probe(file);
  if (it.cancelled) throw new Fatal('Bekor qilindi');

  const q = (offset) => `/api/upload/chunk?uploadId=${uploadId}&offset=${offset}&name=${encodeURIComponent(file.name)}&total=${file.size}`;

  for (let round = 0; round < 2; round++) {
    // Server qancha qabul qilganini so'raymiz (uzilgan yuklashni davom ettirish)
    let sent = 0;
    for (let a = 1; a <= 5; a++) {
      try {
        const r = await fetch(`/api/upload/status?uploadId=${uploadId}`);
        if (r.status === 401) { location.href = './login.html'; return; }
        sent = (await readJson(r)).receivedBytes || 0;
        break;
      } catch { await sleep(1000 * a); }
    }
    if (sent > 0) setRow(it, { text: `Davom ettirilmoqda: ${bytes(sent)} / ${bytes(file.size)}` });

    const t0 = performance.now(); const s0 = sent;
    while (sent < file.size) {
      if (it.cancelled) throw new Fatal('Bekor qilindi');
      const end = Math.min(sent + CHUNK, file.size);
      const chunk = file.slice(sent, end);
      let ok = false;

      for (let attempt = 1; attempt <= MAX_RETRY && !ok; attempt++) {
        it.ac = new AbortController();
        const killer = setTimeout(() => it.ac.abort(), 120_000);
        try {
          const r = await fetch(q(sent), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, signal: it.ac.signal });
          if (r.status === 401) { location.href = './login.html'; return; }
          const data = await readJson(r);
          if (r.status === 409 && typeof data.receivedBytes === 'number') { sent = data.receivedBytes; throw new Error('resync'); }
          if ([400, 403, 413, 415].includes(r.status)) throw new Fatal(data.error || `Xato ${r.status}`);
          if (!r.ok) throw new Error(data.error || `Xato ${r.status}`);
          sent = data.receivedBytes;
          ok = true;
        } catch (e) {
          if (e instanceof Fatal || it.cancelled) throw e;
          if (e.message === 'resync') { ok = true; break; }
          if (attempt >= MAX_RETRY) throw new Error(`Ulanish uzildi (${bytes(sent)} saqlandi). Qaytadan tanlasangiz shu joydan davom etadi.`);
          setRow(it, { text: `Qayta ulanmoqda... (${attempt}/${MAX_RETRY})` });
          await sleep(Math.min(1500 * attempt, 12000));
        } finally { clearTimeout(killer); }
      }

      const pct = Math.round((sent / file.size) * 100);
      const speed = (sent - s0) / Math.max(0.5, (performance.now() - t0) / 1000);
      setRow(it, { pct, text: `Serverga: ${pct}% · ${bytes(speed)}/s` });
    }

    // Yakunlash: server Telegramga yuklashni tugatguncha javob bermasligi mumkin.
    // Tarmoq uzilsa qayta yuboramiz - server takroriy so'rovni dublikatsiz hal qiladi.
    setRow(it, { pct: 100, text: 'Saqlanmoqda...' });
    const body = JSON.stringify({
      uploadId, name: file.name, size: file.size, takenAt: file.lastModified || Date.now(),
      album: it.album || undefined, ...meta,
    });
    let result = null;
    for (let a = 1; a <= 6 && !result; a++) {
      try {
        const r = await fetch('/api/upload/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (r.status === 401) { location.href = './login.html'; return; }
        const data = await readJson(r);
        if (r.ok) { result = data; break; }
        if (r.status === 404 && round === 0) { result = 'restart'; break; }   // server holatni yo'qotgan - boshidan
        throw new Fatal(data.error || `Xato ${r.status}`);
      } catch (e) {
        if (e instanceof Fatal || it.cancelled) throw e;
        if (a >= 6) throw new Error('Saqlash tasdiqlanmadi. Sahifani yangilab, albomni tekshiring.');
        setRow(it, { text: 'Qayta ulanmoqda...' });
        await sleep(3000 * a);
      }
    }
    if (result !== 'restart') return result;
  }
  throw new Error('Yuklab bo\'lmadi, qaytadan urinib ko\'ring');
}

window.addEventListener('beforeunload', (e) => {
  if (hasActive()) { e.preventDefault(); e.returnValue = ''; }
});
