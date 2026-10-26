import './style.css';
import { mountPlaylist, demoState, type PLClip, type PLNote, type PlaylistState, type PlaylistCanvasHandle } from './playlist-canvas';
import { mountPianoRoll, type PianoRollCanvasHandle } from './piano-roll-canvas';

const STORE_KEY = 'daw-starter-project-v1';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const plHost = $('pl-host'), prPanel = $('pr-panel'), prHost = $('pr-host');
const prTitle = $('pr-title'), prDot = $('pr-dot'), savedEl = $('saved');

/* ---------- Tema (terang / gelap) ---------- */
type Theme = 'dark' | 'light';
const THEME_KEY = 'daw-starter-theme';
const APP_VARS: Record<Theme, Record<string, string>> = {
  dark: { '--bg-dark': '#21272B', '--row-black': '#31373B', '--row-white': '#394046', '--rule': '#434C51', '--light': '#C7CEDA' },
  light: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
};
let theme: Theme = (() => { try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } })();

/* ---------- Penyimpanan ---------- */
function loadSaved(): PlaylistState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PlaylistState;
    return Array.isArray(s.tracks) && Array.isArray(s.clips) ? s : null;
  } catch { return null; }
}
let saveTimer = 0;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 400);
}
function saveNow(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(playlist.getState()));
    savedEl.textContent = 'Tersimpan ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { savedEl.textContent = 'Gagal menyimpan (penyimpanan penuh?)'; }
}

/* ---------- Playlist <-> Piano roll ---------- */
let pianoRoll: PianoRollCanvasHandle | null = null;
let editingId: number | null = null;

const playlist: PlaylistCanvasHandle = mountPlaylist(plHost, {
  title: 'DAW Starter',
  theme,
  onChange: () => {
    scheduleSave();
    if (editingId != null && !playlist.getState().clips.some(c => c.id === editingId)) closeEditor();   // clip yang sedang diedit terhapus
  },
  onTransport: playing => { if (playing) pianoRoll?.stop(); },
  onOpenClip: clip => openEditor(clip)
});

const saved = loadSaved();
if (saved) playlist.setState(saved);

// ganti tema: komponen punya dropdown tema sendiri (tersembunyi), jadi cukup set nilainya lalu picu event change
function setComponentTheme(host: HTMLElement, t: Theme): void {
  const sel = host.querySelector<HTMLSelectElement>('[data-r="theme"]');
  if (sel) { sel.value = t; sel.dispatchEvent(new Event('change')); }
}
const themeBtns = document.querySelectorAll<HTMLButtonElement>('#settings [data-theme]');
function applyTheme(t: Theme): void {
  theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* abaikan */ }
  for (const k in APP_VARS[t]) document.documentElement.style.setProperty(k, APP_VARS[t][k]);
  setComponentTheme(plHost, t);
  setComponentTheme(prHost, t);
  themeBtns.forEach(b => b.classList.toggle('on', b.dataset.theme === t));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', APP_VARS[t]['--bg-dark']);
}
themeBtns.forEach(b => { b.onclick = () => applyTheme(b.dataset.theme as Theme); });
const settingsEl = $('settings');
$('btn-settings').onclick = (e) => { e.stopPropagation(); settingsEl.hidden = !settingsEl.hidden; };
settingsEl.addEventListener('pointerdown', e => e.stopPropagation());
document.addEventListener('pointerdown', () => { settingsEl.hidden = true; });
applyTheme(theme);

// panjang piano roll = periode loop clip (2^k bar yang menampung note), minimal 1 bar; clip kosong dibuka selebar clipnya (maks 16 beat)
function pianoLen(clip: PLClip): number {
  const bpb = 4;
  if (clip.notes && clip.notes.length) {
    const end = Math.max(...clip.notes.map(n => n.beat + n.len));
    let p = bpb; while (p < end - 1e-9) p *= 2;
    return p;
  }
  return Math.min(16, Math.max(bpb, Math.ceil(clip.len / bpb) * bpb));
}

function openEditor(clip: PLClip & { id: number }): void {
  const st = playlist.getState();
  const track = st.tracks.find(t => t.id === clip.track);
  const color = track?.color ?? '#F5A12A';
  const notes: PLNote[] = (clip.notes ?? []).map(n => ({ ...n, vel: n.vel ?? 180 }));
  editingId = null;   // jangan kirim balik perubahan selama editor diisi ulang
  prPanel.hidden = false;
  prTitle.textContent = `${clip.name}${track ? ' · ' + track.name : ''}`;
  prDot.style.background = color;
  if (!pianoRoll) {
    pianoRoll = mountPianoRoll(prHost, {
      notes: notes as Required<PLNote>[], clipLen: pianoLen(clip), theme, color, clipOffset: clip.beat,
      onChange: () => {
        if (editingId == null || !pianoRoll) return;
        playlist.setClipNotes(editingId, pianoRoll.getNotes());
      },
      onTransport: playing => { if (playing) playlist.stop(); }
    });
  } else {
    pianoRoll.stop();
    pianoRoll.setClipLen(pianoLen(clip));
    pianoRoll.setColor(color);
    pianoRoll.setClipOffset(clip.beat);
    pianoRoll.setNotes(notes as Required<PLNote>[]);
  }
  editingId = clip.id;
  requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); });
}

function closeEditor(): void {
  editingId = null;
  pianoRoll?.stop();
  prPanel.hidden = true;
  requestAnimationFrame(() => playlist.resize());
}
$('pr-close').onclick = closeEditor;

/* ---------- Toolbar atas ---------- */
function freshState(): PlaylistState {
  return {
    tracks: [
      { id: 1, name: 'Drums', color: '#E8605A' }, { id: 2, name: 'Bass', color: '#5BC77A' },
      { id: 3, name: 'Chords', color: '#F5A12A' }, { id: 4, name: 'Lead', color: '#4FA8E8' }
    ],
    clips: []
  };
}
function confirmReplace(): boolean { return confirm('Ganti project yang sekarang? Perubahan yang belum diekspor akan hilang.'); }
function replaceProject(s: PlaylistState): void {
  closeEditor();
  playlist.stop();
  playlist.setState(s);
  saveNow();
}
$('btn-new').onclick = () => { if (confirmReplace()) replaceProject(freshState()); };
$('btn-demo').onclick = () => { if (confirmReplace()) replaceProject(demoState()); };
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(playlist.getState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const fileIn = $<HTMLInputElement>('file-import');
$('btn-import').onclick = () => fileIn.click();
fileIn.onchange = async () => {
  const f = fileIn.files?.[0]; fileIn.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text()) as PlaylistState;
    if (!Array.isArray(s.tracks) || !Array.isArray(s.clips)) throw new Error('format');
    if (confirmReplace()) replaceProject(s);
  } catch { alert('File project tidak valid.'); }
};

window.addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ---------- Tombol landscape: layar penuh + kunci orientasi ---------- */
const toastEl = $('toast');
let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 3500);
}
$('btn-landscape').onclick = async () => {
  const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  try {
    if (document.fullscreenElement) {
      orient.unlock?.();
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
    if (orient.lock) await orient.lock('landscape');
    else toast('Browser ini tidak bisa mengunci orientasi. Putar HP ke landscape.');
  } catch {
    toast('Tidak bisa mengunci layar. Aktifkan rotasi otomatis lalu putar HP ke landscape.');
  }
};
document.addEventListener('fullscreenchange', () => { requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); }); });
