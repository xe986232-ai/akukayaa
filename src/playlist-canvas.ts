// Playlist / timeline berbasis canvas, pola yang sama dengan piano-roll-canvas.ts.
// Mengikuti hasil bedah CTracksEditor FL Studio Mobile 3.4.5: baris track + celah 1 px, lattice 3 tingkat adaptif,
// clip dengan outline/halo clip aktif, mini note berskala rentang nada, loop 2^k bar dengan segitiga (+ fade ubin non-kursor),
// header track yang bisa melebar (mixer) dengan meter level, geser header = ubah urutan track, tap kosong = tombol "+Clip",
// double-tap = buka editor, menu region (Insert space / Delete space / Trim), copy/paste, mute, zoom+scroll ikut tersimpan.
// Semua state ada di dalam closure mountPlaylist(), jadi bisa dipasang lebih dari satu instance dan dibersihkan lewat destroy().
// Audio masih punya AudioContext sendiri (sama seperti piano roll); belum disambung ke audio-engine.ts.

import './playlist-canvas.css';

export interface PLNote { key: number; beat: number; len: number; vel?: number; }   // beat relatif awal clip, vel 1..255
export interface PLTrack { id: number; name: string; color: string; }
export interface PLClip { id?: number; track: number; beat: number; len: number; name: string; notes?: PLNote[]; muted?: boolean; }
export interface PLView { posH: number; posV: number; zH: number; zV: number; }   // zoom/scroll ikut tersimpan di song
export interface PlaylistState { tracks: PLTrack[]; clips: PLClip[]; view?: PLView; }
export interface PlaylistCanvasOpts {
  tracks?: PLTrack[];
  clips?: PLClip[];
  songLen?: number;            // panjang lagu minimum (ketukan), default 64
  bpm?: number;                // default 120
  theme?: 'light' | 'dark';    // default 'dark'
  title?: string;              // judul lagu, tampil di sudut kiri-atas saat header dilebarkan
  onOpenClip?: (clip: PLClip & { id: number }) => void;   // double-tap pada clip (buka piano roll)
  onChange?: () => void;       // dipanggil setiap data track/clip berubah
  onTransport?: (playing: boolean) => void;   // dipanggil saat play/stop
}
export interface PlaylistCanvasHandle {
  destroy(): void;
  getState(): PlaylistState;
  setState(s: PlaylistState): void;
  setClipNotes(clipId: number, notes: PLNote[]): void;
  resize(): void;
  stop(): void;
}

interface TR extends PLTrack { disp: number; tgt: number; }
interface CL { id: number; track: number; beat: number; len: number; name: string; notes: PLNote[]; sel: boolean; muted: boolean; }
interface Sel { beat: number; row: number; len: number; rows: number; }
interface Pt { x: number; y: number; }
type DragType = 'move' | 'resize';
interface Drag { type: DragType; dBeat: number; dRow: number; dLen: number; }
interface SelDrag { b0: number; r0: number; b1: number; r1: number; }
interface Voice { stop(at?: number): void; }
interface Ev { key: number; beat: number; len: number; vel: number; trk: number; }
interface ClipItem { row: number; beat: number; len: number; name: string; notes: PLNote[]; muted: boolean; }
interface Gs {
  id: number; x: number; y: number; sx: number; sy: number; t: number; mode: string;
  vx: number; vy: number; timer?: number; lastT?: number; p0?: { x: number; y: number; h: number; v: number };
  type?: DragType; s0?: Sel; start?: Pt; minBeat?: number; maxBeat?: number; minRow?: number; maxRow?: number;
  row?: number; held?: boolean; trk?: TR; row0?: number; dropIdx?: number; moved?: boolean;
}
interface Pinch { a: Gs; b: Gs; dx0: number; dy0: number; zH0: number; zV0: number; mb: number; mr: number; }

/* ---------- Token ---------- */
interface Theme {
  bg: string; rb: string; rw: string; rule: string; light: string;
  lat: string; latA: [number, number, number]; clipLine: string; shadow: string;
  rulerBg: string; tick: string; circle: string; circleText: string;
  selBorder: string; selBox: string; handleBg: string; handleFg: string;
  playhead: string; playShadow: string; playW: number;
  css: Record<string, string>;
}
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {   // FLM Studio Mobile
    bg: '#21272B', rb: '#31373B', rw: '#394046', rule: '#434C51', light: '#C7CEDA',
    lat: '#21272B', latA: [1, 1, 1], clipLine: 'rgba(33,39,43,.3)', shadow: 'rgba(0,0,0,.15)',
    rulerBg: '#21272B', tick: '#434C51', circle: '#C7CEDA', circleText: '#21272B',
    selBorder: '#C7CEDA', selBox: 'rgba(199,206,218,.2)', handleBg: '#C7CEDA', handleFg: '#21272B',
    playhead: '#C7CEDA', playShadow: 'rgba(33,39,43,.3)', playW: 2,
    css: { '--bg-dark': '#21272B', '--row-black': '#31373B', '--row-white': '#394046', '--rule': '#434C51', '--light': '#C7CEDA' }
  },
  light: {
    bg: '#B4B4B4', rb: '#B1B1B1', rw: '#C9C9C9', rule: '#8A8A8A', light: '#222222',
    lat: '#000000', latA: [.08, .15, .35], clipLine: 'rgba(0,0,0,.35)', shadow: 'rgba(0,0,0,.12)',
    rulerBg: '#D2D2D2', tick: '#7C7C7C', circle: '#2A2A2A', circleText: '#F1F1F1',
    selBorder: '#2A2A2A', selBox: 'rgba(0,0,0,.12)', handleBg: '#2A2A2A', handleFg: '#F1F1F1',
    playhead: '#1A1A1A', playShadow: 'rgba(255,255,255,.35)', playW: 1,
    css: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
  }
};
const MINLEN = 0.25;
const MINW = 3;                    // lebar clip minimum (px, kelipatan U)
const U = 1;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
// batas zoom dalam satuan "cell": px/beat 1/12..100 cell (2..2400 px bila cell 24), tinggi baris 2..4,17 cell
const ZHMIN = 1 / 12, ZHMAX = 100, ZVMIN = 2, ZVMAX = 1 / 0.24;
const toPos = (v: number, mn: number, mx: number): number => Math.round(100 * Math.log(v / mn) / Math.log(mx / mn));
const fromPos = (p: number, mn: number, mx: number): number => mn * Math.pow(mx / mn, p / 100);
const HDR_CELLS = 1.5, MIXER_CELLS = 12;

function darken(hex: string, k: number): string {   // warna channel x 0,65 untuk isi clip
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number): number => Math.round(clamp(v * k, 0, 255));
  return `rgb(${c(n >> 16 & 255)},${c(n >> 8 & 255)},${c(n & 255)})`;
}

const TEMPLATE = `
<div class="plc-bar">
  <button data-r="play">Play</button>
  <label>BPM <input data-r="bpm" type="number" min="40" max="240" value="120"></label>
  <label>Snap
    <select data-r="snap">
      <option value="auto">Otomatis</option>
      <option value="off">Tanpa snap</option>
      <option value="1/4">1/4 Beat</option>
      <option value="1/2">1/2 Beat</option>
      <option value="1">1 Beat</option>
      <option value="4">1 Bar</option>
    </select>
  </label>
  <label>Tema
    <select data-r="theme">
      <option value="dark">Gelap (FLM)</option>
      <option value="light">Terang</option>
    </select>
  </label>
  <label>UI
    <select data-r="ui">
      <option value="0.75">75%</option>
      <option value="0.9">90%</option>
      <option value="1" selected>100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="1.75">175%</option>
      <option value="2">200%</option>
    </select>
  </label>
  <label>Zoom H <input data-r="zh" type="range" min="0" max="100" value="50"></label>
  <label>Zoom V <input data-r="zv" type="range" min="0" max="100" value="50"></label>
  <button data-r="mixer">Header</button>
  <button data-r="addtrack">+ Track</button>
  <button data-r="paste">Paste</button>
  <button data-r="undo">Undo</button>
  <button data-r="redo">Redo</button>
  <span class="plc-hint">Tap baris: pilih &middot; Tap lagi: tombol +Clip &middot; Double-tap clip: buka editor &middot; Tahan 0,2 dtk: seleksi &middot; Geser header: urutan track &middot; Ctrl+C/X/V: salin/potong/tempel</span>
</div>
<div class="plc-stage">
  <canvas class="plc-cv"></canvas>
  <button class="plc-add" data-r="add">+Clip</button>
  <div class="plc-pop"></div>
</div>`;

// contoh: 4 track, beberapa clip dengan pola note
export function demoState(): PlaylistState {
  const tracks: PLTrack[] = [
    { id: 1, name: 'Kick', color: '#E8605A' }, { id: 2, name: 'Chords', color: '#F5A12A' },
    { id: 3, name: 'Lead', color: '#4FA8E8' }, { id: 4, name: 'Bass', color: '#5BC77A' }
  ];
  const chords = [[60, 63, 67], [56, 60, 63], [63, 67, 70], [58, 62, 65]];
  const chordNotes: PLNote[] = [];
  chords.forEach((ch, bar) => ch.forEach(k => chordNotes.push({ key: k, beat: bar * 4, len: 4, vel: 170 })));
  const lead: PLNote[] = [];
  for (let i = 0; i < 16; i++) lead.push({ key: 72 + [0, 3, 7, 10][i % 4] + (i % 8 > 3 ? 2 : 0), beat: i * 0.5, len: 0.5, vel: 190 });
  const kick: PLNote[] = [0, 1, 2, 3].map(b => ({ key: 36, beat: b, len: 0.25, vel: 230 }));
  const bass: PLNote[] = [0, 4, 8, 12].map((b, i) => ({ key: [36, 32, 39, 34][i], beat: b, len: 3.5, vel: 200 }));
  return {
    tracks,
    clips: [
      { track: 1, beat: 0, len: 32, name: 'Kick', notes: kick },
      { track: 2, beat: 0, len: 16, name: 'Chords A', notes: chordNotes },
      { track: 2, beat: 16, len: 16, name: 'Chords A', notes: chordNotes },
      { track: 3, beat: 8, len: 8, name: 'Lead', notes: lead },
      { track: 3, beat: 24, len: 8, name: 'Lead', notes: lead },
      { track: 4, beat: 0, len: 32, name: 'Bass', notes: bass }
    ]
  };
}

export function mountPlaylist(host: HTMLElement, opts: PlaylistCanvasOpts = {}): PlaylistCanvasHandle {
  const root = document.createElement('div');
  root.className = 'plc';
  root.innerHTML = TEMPLATE;
  host.appendChild(root);

  const $ = <T extends HTMLElement>(r: string): T => root.querySelector<T>(`[data-r="${r}"]`)!;
  const cv = root.querySelector<HTMLCanvasElement>('.plc-cv')!;
  const ctx = cv.getContext('2d')!;
  const stage = root.querySelector<HTMLElement>('.plc-stage')!;
  const pop = root.querySelector<HTMLElement>('.plc-pop')!;
  const bPlay = $<HTMLButtonElement>('play'), bMixer = $<HTMLButtonElement>('mixer'), bAddTrack = $<HTMLButtonElement>('addtrack');
  const bUndo = $<HTMLButtonElement>('undo'), bRedo = $<HTMLButtonElement>('redo'), bAdd = $<HTMLButtonElement>('add');
  const bPaste = $<HTMLButtonElement>('paste');
  const snapSel = $<HTMLSelectElement>('snap'), themeEl = $<HTMLSelectElement>('theme');
  const uiEl = $<HTMLSelectElement>('ui'), bpmEl = $<HTMLInputElement>('bpm');
  const zhEl = $<HTMLInputElement>('zh'), zvEl = $<HTMLInputElement>('zv');

  let C: Theme = THEMES.dark;

  /* ---------- State ---------- */
  let nextClipId = 1, nextTrackId = 1;
  const S = {
    tracks: [] as TR[], clips: [] as CL[], len: opts.songLen ?? 64, spb: 4, bpb: 4, bpm: opts.bpm ?? 120,
    zH: 4, zV: 2.08, posH: 0, posV: 0,
    lastLen: 4, selTrack: 0, cur: 0,                 // cur = id clip aktif (0 = tidak ada)
    sel: null as Sel | null, handles: false,
    mx: 0, mxT: 0                                    // animasi lebar header (0..1)
  };
  let drag: Drag | null = null;
  let selDrag: SelDrag | null = null;
  let inertia: { vx: number; vy: number } | null = null;
  let dirty = true, evDirty = true;
  let addAt: { beat: number; row: number } | null = null;
  let lastTap: { id: number; t: number } | null = null;
  let tapBeat = -1;                                   // beat yang terakhir di-tap (posisi paste + ubin loop yang disorot)
  let clipboard: { items: ClipItem[]; len: number } | null = null;
  const levels = new Map<number, number>();          // level meter per track (0..1)
  const invalidate = (): void => { dirty = true; };
  const touch = (): void => { evDirty = true; dirty = true; opts.onChange?.(); };

  let W = 0, H = 0, dpr = 1, cell = 24, V = 2, uiScale = 1;
  let hdrW = 0, rulerH = 0, areaX = 0, areaY = 0, areaW = 0, areaH = 0;

  const trackIdx = (id: number): number => S.tracks.findIndex(t => t.id === id);
  const trackById = (id: number): TR | undefined => S.tracks.find(t => t.id === id);
  const toTR = (t: PLTrack, i: number): TR => ({ id: t.id, name: t.name, color: t.color, disp: i, tgt: i });
  const toCL = (c: PLClip): CL => ({ id: c.id ?? nextClipId++, track: c.track, beat: c.beat, len: c.len, name: c.name,
    notes: (c.notes ?? []).map(n => ({ ...n })), sel: false, muted: !!c.muted });
  function loadState(s: PlaylistState): void {
    S.tracks = s.tracks.map(toTR);
    nextTrackId = Math.max(0, ...s.tracks.map(t => t.id)) + 1;
    nextClipId = Math.max(0, ...s.clips.map(c => c.id ?? 0)) + 1;
    S.clips = s.clips.filter(c => s.tracks.some(t => t.id === c.track)).map(toCL);
    S.selTrack = S.tracks.length ? S.tracks[0].id : 0;
    S.cur = 0; S.sel = null; S.handles = false; tapBeat = -1;
    if (s.view) { S.posH = s.view.posH; S.posV = s.view.posV; S.zH = s.view.zH; S.zV = s.view.zV; }
  }
  const songLen = (): number => {
    const mx = Math.max(0, ...S.clips.map(c => c.beat + c.len));
    return Math.max(S.len, Math.ceil(mx / S.bpb) * S.bpb);
  };

  /* ---------- Tata letak ---------- */
  function layout(): void {
    cell = Math.max(16, Math.round(24 * uiScale * dpr));
    V = Math.max(1, Math.round(cell / 16));
    // lebar header: 1,5 cell, melebar sampai 13,5 cell saat panel header (mixer) dibuka
    hdrW = Math.round(cell * HDR_CELLS + S.mx * cell * MIXER_CELLS);
    rulerH = Math.round(cell * 1.5);
    areaX = hdrW; areaY = rulerH; areaW = Math.max(10, W - hdrW);
    areaH = Math.max(10, H - rulerH);
    clampView(); invalidate();
  }
  const pxBeat = (): number => S.zH * cell;
  const rowH = (): number => S.zV * cell;
  const bx = (b: number): number => areaX + (b - S.posH) * pxBeat();
  const ry = (r: number): number => areaY + (r - S.posV) * rowH();
  const xToBeat = (x: number): number => (x - areaX) / pxBeat() + S.posH;
  const yToRow = (y: number): number => (y - areaY) / rowH() + S.posV;

  function clampView(): void {
    S.zH = clamp(S.zH, ZHMIN, ZHMAX); S.zV = clamp(S.zV, ZVMIN, ZVMAX);
    const rows = S.tracks.length + 1, vr = areaH / rowH();
    S.posV = clamp(S.posV, 0, Math.max(0, rows + 0.5 - vr));
    const vb = areaW / pxBeat();
    S.posH = clamp(S.posH, 0, Math.max(0, songLen() - vb * 0.25));
  }

  function resize(): void {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(50, Math.round(r.width * dpr)); cv.height = Math.max(50, Math.round(r.height * dpr));
    W = cv.width; H = cv.height;
    layout();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  /* ---------- Snap & lattice ---------- */
  function latticeStep(): number {   // langkah digandakan selama lebar pikselnya < 0,6 cell
    let s = 1 / S.spb; const minPx = cell * 0.6;
    while (s * pxBeat() < minPx) s *= 2;
    return s;
  }
  function fineStep(): number {
    let s = 1 / (S.spb * 32); const minPx = cell * 0.6;
    while (s * pxBeat() < minPx) s *= 2;
    return s;
  }
  function stepBeats(): number {
    const v = snapSel.value;
    if (v === 'off') return 0;
    if (v === 'auto') return fineStep();
    const p = v.split('/');
    return p.length === 2 ? (+p[0]) / (+p[1]) : +p[0];
  }
  function align(b: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
    const st = stepBeats();
    if (!st) return b;
    return r6(Math[mode](b / st + 1e-9) * st);
  }
  function kind(b: number): number {
    if (near(b / S.bpb)) return 2;
    if (near(b)) return 1;
    return 0;
  }
  function loopPeriod(c: CL): number {   // 2^k x bar terkecil yang >= panjang alami isi clip
    const nat = c.notes.length ? Math.max(...c.notes.map(n => n.beat + n.len)) : S.bpb;
    let p = S.bpb; while (p < nat - 1e-9) p *= 2;
    return p;
  }

  /* ---------- Audio ---------- */
  let ac: AudioContext | null = null, master: GainNode | null = null;
  function audio(): AudioContext {
    if (!ac) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ac = new Ctor();
      master = ac.createGain(); master.gain.value = 0.6;
      const comp = ac.createDynamicsCompressor();
      master.connect(comp); comp.connect(ac.destination);
    }
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  }
  function voice(key: number, vel: number, when?: number | null, dur?: number): Voice {
    const a = audio();
    const t = when == null ? a.currentTime : when;
    const f = 440 * Math.pow(2, (key - 69) / 12);
    const g = a.createGain(), g2 = a.createGain();
    const o1 = a.createOscillator(), o2 = a.createOscillator();
    o1.type = 'triangle'; o2.type = 'sine';
    o1.frequency.value = f; o2.frequency.value = f * 2;
    g2.gain.value = 0.25;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(master!);
    const peak = 0.3 * Math.max(0.05, vel);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.setTargetAtTime(peak * 0.6, t + 0.01, 0.25);
    o1.start(t); o2.start(t);
    let stopped = false;
    const stop = (at?: number): void => {
      if (stopped) return; stopped = true;
      const te = Math.max(at == null ? a.currentTime : at, t + 0.02);
      g.gain.cancelScheduledValues(te);
      g.gain.setTargetAtTime(0, te, 0.04);
      o1.stop(te + 0.4); o2.stop(te + 0.4);
    };
    if (dur != null) stop(t + dur);
    return { stop };
  }

  /* ---------- Transport ---------- */
  let events: Ev[] = [];
  function compile(): void {   // ratakan semua clip (termasuk pengulangan loop) jadi daftar note absolut; clip mute dilewati
    events = [];
    for (const c of S.clips) {
      if (!c.notes.length || c.muted) continue;
      const per = loopPeriod(c);
      for (let t = 0; t < c.len - 1e-9; t += per) {
        for (const n of c.notes) {
          const b = t + n.beat;
          if (b >= c.len - 1e-9) continue;
          events.push({ key: n.key, beat: c.beat + b, len: Math.min(n.len, c.len - b), vel: (n.vel ?? 180) / 255, trk: c.track });
        }
      }
    }
    evDirty = false;
  }
  let playing = false, playStartAbs = 0, playT0 = 0, schedAbs = 0, timer: number | null = null, playhead = 0;
  let live: Voice[] = [];
  function curBeat(): number {
    if (!playing) return playhead;
    const L = songLen();
    return ((absNow() % L) + L) % L;
  }
  function absNow(): number { return playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60; }
  function scheduler(): void {
    if (!playing) return;
    if (evDirty) compile();
    const bps = S.bpm / 60, L = songLen();
    const A = schedAbs, B = absNow() + 0.15 * bps;
    if (B <= A) return;
    const k0 = Math.floor(A / L), k1 = Math.floor(B / L);
    for (let k = k0; k <= k1; k++) {
      for (const e of events) {
        const nb = e.beat + k * L;
        if (nb >= A && nb < B) {
          const when = Math.max(playT0 + (nb - playStartAbs) / bps, ac!.currentTime);
          live.push(voice(e.key, e.vel, when, e.len / bps));
        }
      }
    }
    if (live.length > 300) live = live.slice(-150);
    schedAbs = B;
  }
  function startPlay(): void {
    const a = audio();
    playing = true; playStartAbs = playhead; playT0 = a.currentTime + 0.05; schedAbs = playStartAbs;
    timer = window.setInterval(scheduler, 25); scheduler();
    bPlay.textContent = 'Stop'; bPlay.classList.add('on'); invalidate();
    opts.onTransport?.(true);
  }
  function stopPlay(): void {
    const was = playing;
    if (playing) playhead = curBeat();
    playing = false; if (timer != null) clearInterval(timer); timer = null;
    live.forEach(v => v.stop()); live = [];
    bPlay.textContent = 'Play'; bPlay.classList.remove('on'); invalidate();
    if (was) opts.onTransport?.(false);
  }
  function togglePlay(): void { playing ? stopPlay() : startPlay(); }
  function seekTo(x: number): void {
    const ls = latticeStep();
    const b = clamp(Math.round(xToBeat(x) / ls) * ls, 0, songLen());
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; }
    else playhead = b;
    invalidate();
  }

  /* meter level per track: dihitung dari note yang sedang berbunyi di posisi playhead, naik cepat dan turun pelan */
  function updateLevels(): boolean {
    const tgt = new Map<number, number>();
    if (playing) {
      if (evDirty) compile();
      const b = curBeat();
      for (const e of events) {
        if (b >= e.beat && b < e.beat + e.len) tgt.set(e.trk, Math.max(tgt.get(e.trk) ?? 0, e.vel));
      }
    }
    let changed = false;
    for (const t of S.tracks) {
      const cur = levels.get(t.id) ?? 0, g = tgt.get(t.id) ?? 0;
      let nv = g > cur ? cur + (g - cur) * 0.6 : cur * 0.9;
      if (nv < 0.01) nv = 0;
      if (nv !== cur) { levels.set(t.id, nv); changed = true; }
    }
    return changed;
  }

  /* ---------- Undo ---------- */
  const undoS: string[] = [], redoS: string[] = [];
  const snapshot = (): string => JSON.stringify({
    tracks: S.tracks.map(t => ({ id: t.id, name: t.name, color: t.color })),
    clips: S.clips.map(c => ({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes, muted: c.muted })),
    selTrack: S.selTrack
  });
  function updUndo(): void { bUndo.disabled = !undoS.length; bRedo.disabled = !redoS.length; }
  function saveUndo(): void { undoS.push(snapshot()); if (undoS.length > 200) undoS.shift(); redoS.length = 0; updUndo(); }
  function cancelUndo(): void { undoS.pop(); updUndo(); }
  function loadSnap(s: string): void {
    const o = JSON.parse(s) as PlaylistState & { selTrack: number };
    const keep = nextClipId;
    loadState(o); nextClipId = Math.max(nextClipId, keep);
    S.selTrack = trackById(o.selTrack) ? o.selTrack : (S.tracks[0]?.id ?? 0);
    updUndo(); clampView(); touch();
  }
  function undo(): void { if (!undoS.length) return; redoS.push(snapshot()); loadSnap(undoS.pop()!); }
  function redo(): void { if (!redoS.length) return; undoS.push(snapshot()); loadSnap(redoS.pop()!); }

  /* ---------- Seleksi ---------- */
  const selClips = (): CL[] => S.clips.filter(c => c.sel);
  function bound(arr: CL[]): Sel {
    const rows = arr.map(c => trackIdx(c.track));
    const minB = Math.min(...arr.map(c => c.beat)), maxE = Math.max(...arr.map(c => c.beat + c.len));
    const minR = Math.min(...rows), maxR = Math.max(...rows);
    return { beat: minB, row: minR, len: maxE - minB, rows: maxR - minR + 1 };
  }
  function resetSel(): void { S.clips.forEach(c => c.sel = false); S.sel = null; S.handles = false; selDrag = null; tapBeat = -1; invalidate(); }
  function selectOnly(c: CL): void {
    S.clips.forEach(x => x.sel = false); c.sel = true;
    S.cur = c.id; S.selTrack = c.track; S.sel = bound([c]); S.handles = true; hideAdd(); invalidate();
  }
  function refreshSel(): void {
    const a = selClips();
    if (!a.length) resetSel(); else S.sel = bound(a);
    invalidate();
  }
  function hideAdd(): void { addAt = null; bAdd.style.display = 'none'; }

  /* ---------- Clip: koordinat tunggal ---------- */
  function shifted(c: CL): { beat: number; row: number; len: number } {
    const base = trackIdx(c.track);
    let beat = c.beat, len = c.len, idx = base;
    if (drag && c.sel) {
      if (drag.type === 'move') { beat += drag.dBeat; idx = clamp(base + drag.dRow, 0, S.tracks.length - 1); }
      else len = Math.max(MINLEN, len + drag.dLen);
    }
    const t = S.tracks[idx];
    return { beat, row: t ? (drag && c.sel && drag.type === 'move' ? t.disp : (trackById(c.track)?.disp ?? idx)) : idx, len };
  }
  function clipRectPx(c: CL): { x: number; y: number; w: number; h: number } {
    const s = shifted(c);
    const x0 = Math.round(bx(s.beat)), x1 = Math.round(bx(s.beat + s.len));
    const y0 = Math.round(ry(s.row)) + U, y1 = Math.round(ry(s.row + 1)) - 2 * U;   // lane dikurangi celah 1 px, clip masuk 1 px
    return { x: x0, y: y0, w: Math.max(x1 - x0, MINW * U), h: y1 - y0 };
  }
  function selDisp(): Sel | null {
    const s = S.sel; if (!s) return null;
    let { beat, row, len, rows } = s;
    if (drag) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else len = Math.max(MINLEN, len + drag.dLen);
    }
    return { beat, row, len, rows };
  }
  function hitClip(x: number, y: number): CL | null {
    for (let i = S.clips.length - 1; i >= 0; i--) {
      const c = S.clips[i], r = clipRectPx(c);
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return c;
    }
    return null;
  }

  /* ---------- Menggambar ---------- */
  function lanes(): { y0: number; y1: number } {   // rentang vertikal lattice: baris pertama sampai baris kosong ekstra
    const top = Math.max(areaY, Math.round(ry(0)));
    const bot = Math.min(areaY + areaH, Math.round(ry(S.tracks.length + 1)) - U);
    return { y0: top, y1: bot };
  }
  function drawLattice(): void {
    const ls = latticeStep(), pb = pxBeat();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    const { y0, y1 } = lanes();
    if (y1 <= y0) return;
    ctx.fillStyle = C.lat;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls;
      if (b < -1e-9) continue;
      const x = bx(b), kd = kind(b);
      const w = kd === 2 ? 4 * U : kd === 1 ? 2 * U : U;
      const off = kd === 2 ? 2 * U : U;
      ctx.globalAlpha = C.latA[kd];
      ctx.fillRect(Math.round(x - off), y0, w, y1 - y0);
    }
    ctx.globalAlpha = 1;
  }
  function drawRows(): void {
    const x0 = Math.max(areaX, Math.round(bx(0)));
    for (const t of S.tracks) {
      const y0 = Math.round(ry(t.disp)), y1 = Math.round(ry(t.disp + 1)) - U;   // celah 1 px antar baris
      if (y1 < areaY || y0 > areaY + areaH) continue;
      ctx.fillStyle = t.id === S.selTrack && S.tracks.length > 1 ? C.rw : C.rb;
      ctx.fillRect(x0, y0, areaX + areaW - x0, y1 - y0);
    }
  }
  function drawShadow(): void {
    const x = bx(songLen());
    if (x < areaX + areaW) {
      const x0 = Math.max(areaX, Math.round(x)), { y0, y1 } = lanes();
      ctx.fillStyle = C.shadow; ctx.fillRect(x0, y0, areaX + areaW - x0, y1 - y0);
    }
  }
  const shiftedBeat = (c: CL): number => shifted(c).beat;
  function drawClipContent(c: CL, r: { x: number; y: number; w: number; h: number }, beatLen: number, col: string, cursor: number): void {
    if (!c.notes.length) return;
    const pb = pxBeat(), per = loopPeriod(c), ga = ctx.globalAlpha;
    let lo = 127, hi = 0;
    for (const n of c.notes) { lo = Math.min(lo, n.key); hi = Math.max(hi, n.key); }
    const step = r.h / (hi - lo + 2);   // rentang nada + 2 baris cadangan memenuhi tinggi clip
    ctx.fillStyle = col;
    const first = Math.max(0, Math.floor(Math.max(0, S.posH - c.beat) / per));
    for (let t = first * per; t < beatLen - 1e-9; t += per) {
      const tx = bx(c.beat + t + (shiftedBeat(c) - c.beat));
      if (tx > areaX + areaW) break;
      if (tx + per * pb < areaX) continue;
      if (t > 0) {   // segitiga kecil di batas pengulangan
        const px = Math.round(tx);
        ctx.fillStyle = C.bg;
        ctx.beginPath(); ctx.moveTo(px - 2 * V, r.y); ctx.lineTo(px + 2 * V, r.y); ctx.lineTo(px, r.y + 2 * V); ctx.closePath(); ctx.fill();
      }
      // ada beat kursor: ubin yang tidak memuat kursor dipudarkan ke alpha 0,25
      const active = cursor < 0 || (cursor >= t - 1e-9 && cursor < t + per - 1e-9);
      ctx.globalAlpha = active ? ga : ga * 0.25;
      ctx.fillStyle = col;
      for (const n of c.notes) {
        const b = t + n.beat;
        if (b >= beatLen - 1e-9) continue;
        const nx = Math.round(tx + n.beat * pb);
        const nw = Math.max(Math.round(Math.min(n.len, beatLen - b) * pb), U);
        if (nx + nw < areaX || nx > areaX + areaW) continue;
        const ny = Math.round(r.y + (hi - n.key + 1) * step - V / 2);
        ctx.fillRect(nx, ny, nw, V);
      }
      ctx.globalAlpha = ga;
    }
  }
  function drawClip(c: CL): void {
    const r = clipRectPx(c);
    if (r.x + r.w < areaX || r.x > areaX + areaW || r.y + r.h < areaY || r.y > areaY + areaH) return;
    const tr = trackById(c.track); if (!tr) return;
    const s = shifted(c);
    const isCur = c.id === S.cur && c.track === S.selTrack;
    ctx.globalAlpha = c.muted ? 0.45 : 1;
    if (isCur) {   // halo gelap 5 px + bingkai terang 4 px di atas dan bawah clip aktif
      ctx.fillStyle = C.bg; ctx.fillRect(r.x, r.y - 5 * U, r.w, r.h + 10 * U);
      ctx.fillStyle = C.light; ctx.fillRect(r.x, r.y - 4 * U, r.w, r.h + 8 * U);
    }
    ctx.fillStyle = C.clipLine; ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.fillStyle = tr.color; ctx.fillRect(r.x, r.y, r.w, r.h);
    const dk = darken(tr.color, 0.65);
    ctx.save();
    ctx.beginPath(); ctx.rect(Math.max(r.x, areaX), r.y, Math.min(r.x + r.w, areaX + areaW) - Math.max(r.x, areaX), r.h); ctx.clip();
    ctx.fillStyle = dk; ctx.font = Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tx = Math.max(r.x, areaX) + 4 * U;
    if (r.x + r.w - tx > 6 * U) ctx.fillText(c.name, tx, r.y + cell * 0.35 + U);
    const body = { x: r.x, y: r.y + Math.round(cell * 0.7), w: r.w, h: r.h - Math.round(cell * 0.7) - 2 * U };
    const cursor = isCur && tapBeat >= c.beat && tapBeat < c.beat + c.len ? tapBeat - c.beat : -1;
    if (body.h > 4) drawClipContent(c, body, s.len, dk, cursor);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function drawClips(): void {
    for (const pass of [false, true]) {   // yang terseleksi digambar belakangan supaya di atas
      for (const c of S.clips) if (c.sel === pass) drawClip(c);
    }
  }
  function drawRowMarker(): void {   // segitiga penunjuk di tepi kiri baris terpilih
    const t = trackById(S.selTrack); if (!t) return;
    const y = (ry(t.disp) + ry(t.disp + 1)) / 2, T = cell * 0.4;
    ctx.fillStyle = C.tick;
    ctx.beginPath(); ctx.moveTo(areaX, y - T); ctx.lineTo(areaX, y + T); ctx.lineTo(areaX + T, y); ctx.closePath(); ctx.fill();
  }
  function drawMeter(t: TR, y0: number, y1: number, cw: number, sel: boolean): void {
    const lv = levels.get(t.id) ?? 0;
    ctx.fillStyle = sel ? C.rw : t.color;
    if (S.mx < 0.5) {   // header sempit: dua bar vertikal tipis (L, R) di tepi kanan, alas 4V di atas dasar baris
      const base = y1 - 4 * V, maxH = Math.max(0, (y1 - y0) - 8 * V), h = Math.round(maxH * lv);
      if (h > 0) { ctx.fillRect(cw - 4 * V, base - h, V, h); ctx.fillRect(cw - 2 * V, base - h, V, h); }
    } else {            // mixer terbuka: dua bar horizontal (L di atas R), maks 5,5 cell, mulai 5,75 cell dari tepi kanan
      const x = cw - Math.round(cell * 5.75), w = Math.round(cell * 5.5 * lv), th = Math.max(1, Math.round(cell * 0.25));
      const yL = y1 - Math.round(cell * 0.9), yR = yL + th + V;
      ctx.globalAlpha = S.mx;
      if (w > 0) { ctx.fillRect(x, yL, w, th); ctx.fillRect(x, yR, w, th); }
      ctx.globalAlpha = 1;
    }
  }
  function drawHeader(): void {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, areaY, hdrW, areaH); ctx.clip();
    ctx.fillStyle = C.bg; ctx.fillRect(0, areaY, hdrW, areaH);
    const cw = hdrW - U, iw = Math.round(cell * HDR_CELLS);
    ctx.font = Math.round(cell * 0.46) + 'px system-ui,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const order = [...S.tracks].sort((a, b) => (a === dragTrack ? 1 : 0) - (b === dragTrack ? 1 : 0));   // track yang digeser di atas
    for (const t of order) {
      const y0 = Math.round(ry(t.disp)), y1 = Math.round(ry(t.disp + 1)) - U;
      if (y1 < areaY || y0 > areaY + areaH) continue;
      const sel = t.id === S.selTrack;
      ctx.fillStyle = sel ? t.color : C.rw; ctx.fillRect(0, y0, cw, y1 - y0);
      // ikon: lingkaran; baris terpilih memakai warna gelap, baris lain warna channel
      ctx.fillStyle = sel ? C.rw : t.color;
      ctx.beginPath(); ctx.arc(iw / 2, (y0 + y1) / 2, cell * 0.28, 0, Math.PI * 2); ctx.fill();
      if (S.mx > 0.05) {
        ctx.globalAlpha = S.mx; ctx.fillStyle = sel ? C.rw : C.light;
        ctx.save(); ctx.beginPath(); ctx.rect(iw, y0, cw - iw, y1 - y0); ctx.clip();
        ctx.fillText(t.name, iw + cell * 0.2, (y0 + y1) / 2); ctx.restore();
        ctx.globalAlpha = 1;
      }
      drawMeter(t, y0, y1, cw, sel);
    }
    // baris kosong ekstra = tambah track
    const ya = Math.round(ry(S.tracks.length)), yb = Math.round(ry(S.tracks.length + 1)) - U;
    if (yb > areaY && ya < areaY + areaH) {
      ctx.fillStyle = C.rb; ctx.fillRect(0, ya, cw, yb - ya);
      const cx = iw / 2, cy = (ya + yb) / 2, a = cell * 0.25;
      ctx.fillStyle = C.tick; ctx.fillRect(cx - a, cy - V / 2, a * 2, V); ctx.fillRect(cx - V / 2, cy - a, V, a * 2);
    }
    ctx.restore();
  }
  function drawRuler(): void {
    const pb = pxBeat();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, 0, areaW, rulerH); ctx.clip();
    ctx.fillStyle = C.rulerBg; ctx.fillRect(areaX, 0, areaW, rulerH);
    const ls = latticeStep();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    ctx.fillStyle = C.tick;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls, x = bx(b), kd = kind(b);
      const h = Math.round(rulerH * (kd ? 0.3 : 0.2));
      const w = kd === 2 ? 2 * V : V;
      ctx.fillRect(Math.round(x - w / 2), rulerH - h, w, h);
    }
    let m = 1; while (S.bpb * m * pb < cell * 1.6) m *= 2;
    const i0 = Math.floor(S.posH / (S.bpb * m)), i1 = Math.ceil((S.posH + areaW / pb) / (S.bpb * m));
    ctx.font = 'bold ' + Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = i0; i <= i1; i++) {
      const b = i * S.bpb * m; if (b < 0 || b >= songLen()) continue;
      const x = bx(b), ccx = x + 6 * V + U, ccy = rulerH * 0.38;
      ctx.fillStyle = C.circle; ctx.beginPath(); ctx.arc(ccx, ccy, 6 * V, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.circleText; ctx.fillText(String(i * m + 1), ccx, ccy + 1);
    }
    ctx.fillStyle = C.tick; ctx.fillRect(areaX, rulerH - V, areaW, V);
    ctx.restore();
  }
  function drawSelBox(b0: number, r0: number, len: number, rows: number): void {
    const x0 = Math.round(bx(b0)), x1 = Math.round(bx(b0 + len));
    const y0 = Math.round(ry(r0)), y1 = Math.round(ry(r0 + rows));
    const w = Math.max(x1 - x0, V * 2), h = y1 - y0;
    ctx.fillStyle = C.selBox; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = C.selBorder;
    ctx.fillRect(x0, y0, w, V); ctx.fillRect(x0, y0 + h - V, w, V);
    ctx.fillRect(x0, y0, V, h); ctx.fillRect(x0 + w - V, y0, V, h);
  }
  type HandleKind = 'move' | 'menu' | 'resize';
  function handlePos(): Record<HandleKind, Pt> {
    const sd = selDisp()!, r = cell * 0.45;
    const x0 = bx(sd.beat), x1 = bx(sd.beat + sd.len), y0 = ry(sd.row), y1 = ry(sd.row + sd.rows);
    const cl = (p: Pt): Pt => ({ x: clamp(p.x, areaX + r, areaX + areaW - r), y: clamp(p.y, areaY + r, areaY + areaH - r) });
    return {
      move: cl({ x: (x0 + x1) / 2, y: y1 + cell * 0.75 }),
      menu: cl({ x: (x0 + x1) / 2, y: y0 - cell * 0.8 }),
      resize: cl({ x: x1 + cell * 0.65, y: (y0 + y1) / 2 })
    };
  }
  function drawHandle(kindName: HandleKind, p: Pt): void {
    const r = cell * 0.45, a = r * 0.5;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.handleFg; ctx.fillStyle = C.handleFg; ctx.lineWidth = Math.max(2, Math.round(1.5 * dpr)); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    const k3 = 3 * dpr;
    const head = (x: number, y: number, dx: number, dy: number): void => { ctx.moveTo(x - dx * k3 - dy * k3, y - dy * k3 + dx * k3); ctx.lineTo(x, y); ctx.lineTo(x - dx * k3 + dy * k3, y - dy * k3 - dx * k3); };
    if (kindName === 'move') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y); ctx.moveTo(p.x, p.y - a); ctx.lineTo(p.x, p.y + a);
      head(p.x + a, p.y, 1, 0); head(p.x - a, p.y, -1, 0); head(p.x, p.y + a, 0, 1); head(p.x, p.y - a, 0, -1);
      ctx.stroke();
    } else if (kindName === 'resize') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
      head(p.x + a, p.y, 1, 0); head(p.x - a, p.y, -1, 0);
      ctx.stroke();
    } else {
      for (const dx of [-a, 0, a]) { ctx.beginPath(); ctx.arc(p.x + dx, p.y, 2 * dpr, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  function drawSelector(): void {
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    if (selDrag) {
      const b0 = Math.min(selDrag.b0, selDrag.b1), b1 = Math.max(selDrag.b0, selDrag.b1);
      const r0 = Math.min(selDrag.r0, selDrag.r1), r1 = Math.max(selDrag.r0, selDrag.r1);
      drawSelBox(b0, r0, Math.max(b1 - b0, 0), r1 - r0 + 1);
    }
    const sd = selDisp();
    if (sd) {
      drawSelBox(sd.beat, sd.row, sd.len, sd.rows);
      if (S.handles) {
        const hp = handlePos();
        drawHandle('menu', hp.menu); drawHandle('move', hp.move); drawHandle('resize', hp.resize);
      }
    }
    ctx.restore();
  }
  function drawPlayhead(): void {
    const ph = curBeat();
    const x = Math.round(bx(ph));
    if (x < areaX || x > areaX + areaW) return;
    const pw = Math.max(U, Math.round(C.playW * V)), h0 = Math.floor(pw / 2);
    ctx.fillStyle = C.playShadow; ctx.fillRect(x - h0 - U, 0, pw + 2 * U, areaY + areaH);
    ctx.fillStyle = C.playhead; ctx.fillRect(x - h0, 0, pw, areaY + areaH);
  }
  function drawCorner(): void {
    ctx.fillStyle = C.rulerBg; ctx.fillRect(0, 0, hdrW, rulerH);
    const iw = Math.round(cell * HDR_CELLS);
    const cx = iw / 2, cy = rulerH / 2, r = Math.min(iw, rulerH) * 0.38;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.handleFg;
    if (playing) { const a = r * 0.45; ctx.fillRect(cx - a, cy - a, a * 2, a * 2); }
    else {
      const a = r * 0.5;
      ctx.beginPath(); ctx.moveTo(cx - a * 0.6, cy - a); ctx.lineTo(cx + a, cy); ctx.lineTo(cx - a * 0.6, cy + a); ctx.closePath(); ctx.fill();
    }
    if (S.mx > 0.95 && opts.title) {   // judul lagu hanya saat header terbuka penuh
      ctx.fillStyle = C.light; ctx.font = Math.round(cell * 0.46) + 'px system-ui,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(opts.title, Math.round(cell * 2), cy, hdrW - Math.round(cell * 2) - cell * 0.3);
    }
    ctx.fillStyle = C.tick; ctx.fillRect(0, rulerH - V, hdrW, V);
  }
  function draw(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    drawRows();
    drawLattice();
    drawShadow();
    drawClips();
    drawRowMarker();
    ctx.restore();
    drawHeader();
    drawRuler();
    drawSelector();
    drawPlayhead();
    drawCorner();
  }

  /* ---------- Operasi ---------- */
  function addTrack(): void {
    saveUndo();
    const pal = ['#F5A12A', '#4FA8E8', '#5BC77A', '#E8605A', '#A678E8', '#E6D24F'];
    const id = nextTrackId++;
    S.tracks.push(toTR({ id, name: 'Track ' + id, color: pal[(id - 1) % pal.length] }, S.tracks.length));
    S.selTrack = id; hideAdd();
    S.posV = Math.max(S.posV, S.tracks.length + 1.5 - areaH / rowH());
    clampView(); touch();
  }
  function createClip(beat: number, row: number): void {
    const t = S.tracks[row]; if (!t) return;
    saveUndo();
    const b = Math.max(0, align(beat, 'floor'));
    const c: CL = { id: nextClipId++, track: t.id, beat: b, len: S.lastLen, name: 'Clip ' + (S.clips.filter(x => x.track === t.id).length + 1), notes: [], sel: false, muted: false };
    S.clips.push(c);
    selectOnly(c); touch();
  }
  function deleteSel(): void {
    if (!selClips().length) return;
    saveUndo();
    S.clips = S.clips.filter(c => !c.sel);
    S.cur = 0; resetSel(); touch();
  }
  function duplicateSel(): void {
    const a = selClips(); if (!a.length || !S.sel) return;
    saveUndo();
    const l = S.sel.len, added: CL[] = [];
    for (const c of a) {
      c.sel = false;
      added.push({ id: nextClipId++, track: c.track, beat: r6(c.beat + l), len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), sel: true, muted: c.muted });
    }
    S.clips.push(...added);
    S.sel = { ...S.sel, beat: r6(S.sel.beat + l) }; S.cur = added[0].id; S.handles = true; touch();
  }
  function splitClipAt(c: CL, p: number): CL | null {   // potong clip di beat p; c jadi bagian kiri, yang dikembalikan bagian kanan
    if (p <= c.beat + 1e-6 || p >= c.beat + c.len - 1e-6) return null;
    const k = p - c.beat;
    const right: CL = {
      id: nextClipId++, track: c.track, beat: r6(p), len: r6(c.len - k), name: c.name, muted: c.muted, sel: false,
      notes: c.notes.map(n => ({ ...n, beat: n.beat - k })).filter(n => n.beat + n.len > 0).map(n => n.beat < 0 ? { ...n, len: n.len + n.beat, beat: 0 } : n)
    };
    c.len = r6(k);
    c.notes = c.notes.filter(n => n.beat < k);
    return right;
  }
  function splitAtPlayhead(): void {
    const p = curBeat(); const a = selClips().filter(c => p > c.beat + 1e-6 && p < c.beat + c.len - 1e-6);
    if (!a.length) return;
    saveUndo();
    for (const c of a) {
      const right = splitClipAt(c, p);
      if (right) { right.sel = true; S.clips.push(right); }
    }
    refreshSel(); touch();
  }
  function selectAll(): void {
    if (!S.clips.length) return;
    S.clips.forEach(c => c.sel = true); S.sel = bound(S.clips); S.handles = true; invalidate();
  }
  function toggleMute(): void {
    const a = selClips(); if (!a.length) return;
    saveUndo();
    const to = !a.every(c => c.muted);
    a.forEach(c => c.muted = to);
    touch();
  }

  /* region: bekerja pada rentang beat + baris seleksi (Insert space, Delete space, Trim selection) */
  function regionIds(): Set<number> {
    const s = S.sel, ids = new Set<number>();
    if (s) for (let r = s.row; r < s.row + s.rows; r++) if (S.tracks[r]) ids.add(S.tracks[r].id);
    return ids;
  }
  function insertSpace(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, l = s.len, add: CL[] = [];
    for (const c of S.clips) if (ids.has(c.track)) { const r = splitClipAt(c, b); if (r) add.push(r); }
    S.clips.push(...add);
    for (const c of S.clips) if (ids.has(c.track) && c.beat >= b - 1e-9) c.beat = r6(c.beat + l);
    resetSel(); touch();
  }
  function deleteSpace(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, e = s.beat + s.len, l = s.len, add: CL[] = [];
    for (const c of S.clips) {
      if (!ids.has(c.track)) continue;
      const r1 = splitClipAt(c, e); if (r1) add.push(r1);
      const mid = splitClipAt(c, b); if (mid) add.push(mid);
    }
    S.clips.push(...add);
    S.clips = S.clips.filter(c => !(ids.has(c.track) && c.beat >= b - 1e-9 && c.beat + c.len <= e + 1e-9));
    for (const c of S.clips) if (ids.has(c.track) && c.beat >= e - 1e-9) c.beat = r6(c.beat - l);
    S.cur = 0; resetSel(); touch();
  }
  function trimSel(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, e = s.beat + s.len, add: CL[] = [], drop = new Set<CL>();
    for (const c of S.clips) {
      if (!ids.has(c.track)) continue;
      if (c.beat >= e - 1e-9 || c.beat + c.len <= b + 1e-9) { drop.add(c); continue; }
      const r1 = splitClipAt(c, e); if (r1) drop.add(r1);
      const mid = splitClipAt(c, b); if (mid) { add.push(mid); drop.add(c); }
    }
    S.clips.push(...add);
    S.clips = S.clips.filter(c => !drop.has(c));
    S.cur = 0; resetSel(); touch();
  }

  /* clipboard */
  function copySel(): void {
    const a = selClips(); if (!a.length) return;
    const b0 = Math.min(...a.map(c => c.beat)), r0 = Math.min(...a.map(c => trackIdx(c.track)));
    clipboard = {
      len: Math.max(...a.map(c => c.beat + c.len)) - b0,
      items: a.map(c => ({ row: trackIdx(c.track) - r0, beat: r6(c.beat - b0), len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted }))
    };
    bPaste.disabled = false;
  }
  function cutSel(): void { copySel(); deleteSel(); }
  function pasteClip(): void {
    if (!clipboard || !S.tracks.length) return;
    saveUndo();
    const maxOff = Math.max(...clipboard.items.map(i => i.row));
    const at = tapBeat >= 0 ? tapBeat : (addAt ? addAt.beat : (S.sel ? S.sel.beat + S.sel.len : curBeat()));
    const b0 = Math.max(0, align(at, 'floor'));
    const baseRow = clamp(Math.max(0, trackIdx(S.selTrack)), 0, Math.max(0, S.tracks.length - 1 - maxOff));
    S.clips.forEach(c => c.sel = false);
    const added: CL[] = [];
    for (const i of clipboard.items) {
      const t = S.tracks[clamp(baseRow + i.row, 0, S.tracks.length - 1)];
      added.push({ id: nextClipId++, track: t.id, beat: r6(b0 + i.beat), len: i.len, name: i.name, notes: i.notes.map(n => ({ ...n })), sel: true, muted: i.muted });
    }
    S.clips.push(...added);
    S.cur = added[0].id; S.selTrack = added[0].track; S.sel = bound(added); S.handles = true; hideAdd(); touch();
  }

  /* ---------- Popup ---------- */
  function closePop(): void { pop.style.display = 'none'; }
  function showPop(x: number, y: number, items: Array<[string, () => void]>): void {
    pop.innerHTML = '';
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { closePop(); fn(); };
      pop.appendChild(b);
    }
    pop.style.display = 'flex';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(x / dpr - pw / 2, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(y / dpr - ph / 2, 4, H / dpr - ph - 4) + 'px';
  }
  function openMenu(p: Pt): void {
    const items: Array<[string, () => void]> = [
      ['Deselect', resetSel], ['Copy', copySel], ['Cut', cutSel]
    ];
    const one = selClips();
    if (one.length === 1) items.unshift(['Edit', () => editClip(one[0])]);
    if (clipboard) items.push(['Paste', pasteClip]);
    items.push(
      ['Duplicate', duplicateSel], ['Mute / Unmute', toggleMute], ['Split di playhead', splitAtPlayhead],
      ['Insert space', insertSpace], ['Delete space', deleteSpace], ['Trim selection', trimSel], ['Delete', deleteSel]
    );
    showPop(p.x, p.y, items);
  }
  function editClip(c: CL): void {   // buka editor (piano roll) untuk clip ini
    opts.onOpenClip?.({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted });
  }
  function showClipPop(c: CL, q: Pt): void {   // popup klip: Edit, More... (seperti FL Studio Mobile)
    const y = clipRectPx(c).y - cell * 1.1;
    showPop(q.x, y, [['Edit', () => editClip(c)], ['More…', () => openMenu({ x: q.x, y })]]);
  }
  function showAdd(q: Pt, row: number): void {
    const t = S.tracks[row]; if (!t) return;
    addAt = { beat: xToBeat(q.x), row };
    const sz = cell * 1.5 / dpr, cy = (ry(row) + ry(row + 1)) / 2 / dpr;
    bAdd.style.cssText = `display:flex;width:${sz}px;height:${sz}px;left:${q.x / dpr - sz / 2}px;top:${cy - sz / 2}px;font-size:${Math.max(10, sz * 0.28)}px`;
  }
  bAdd.onclick = () => { if (addAt) { const a = addAt; hideAdd(); createClip(a.beat, a.row); } };

  /* ---------- Pointer / gesture ---------- */
  const ptrs = new Map<number, Gs>();
  let pinch: Pinch | null = null;
  let dragTrack: TR | null = null;
  const pt = (e: { clientX: number; clientY: number }): Pt => { const r = cv.getBoundingClientRect(); const k = cv.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
  const inArea = (x: number, y: number): boolean => x >= areaX && x < areaX + areaW && y >= areaY && y < areaY + areaH;

  function beginDrag(gs: Gs, type: DragType, q: Pt): void {
    saveUndo();
    const sc = selClips(), rows = sc.map(c => trackIdx(c.track));
    gs.mode = 'drag'; gs.type = type; gs.s0 = { ...S.sel! }; gs.start = q;
    gs.minBeat = Math.min(...sc.map(c => c.beat)); gs.maxBeat = Math.max(...sc.map(c => c.beat));
    gs.minRow = Math.min(...rows); gs.maxRow = Math.max(...rows);
    drag = { type, dBeat: 0, dRow: 0, dLen: 0 };
    invalidate();
  }
  function dragMove(gs: Gs, q: Pt): void {
    const d = drag!, pb = pxBeat(), rh = rowH(), s0 = gs.s0!;
    const dx = q.x - gs.start!.x, dy = q.y - gs.start!.y;
    if (gs.type === 'move') {
      let dB = r6(align(s0.beat + dx / pb) - s0.beat);
      dB = Math.max(dB, -gs.minBeat!);
      d.dBeat = dB;
      d.dRow = clamp(Math.round(dy / rh), -gs.minRow!, S.tracks.length - 1 - gs.maxRow!);
    } else {
      const end = align(s0.beat + s0.len + dx / pb);
      d.dLen = r6(Math.max(MINLEN, end - s0.beat) - s0.len);
    }
    invalidate();
  }
  function commitDrag(): void {
    const d = drag!; drag = null;
    if (!(d.dBeat || d.dRow || d.dLen)) { cancelUndo(); invalidate(); return; }
    for (const c of selClips()) {
      if (d.type === 'move') {
        c.beat = r6(Math.max(0, c.beat + d.dBeat));
        const t = S.tracks[clamp(trackIdx(c.track) + d.dRow, 0, S.tracks.length - 1)];
        c.track = t.id;
      } else c.len = Math.max(MINLEN, r6(c.len + d.dLen));
    }
    if (d.type === 'resize') S.lastLen = selClips()[0].len;
    const cur = S.clips.find(c => c.id === S.cur);
    if (cur && cur.sel) S.selTrack = cur.track;
    S.sel = bound(selClips()); touch();
  }

  function beginSelect(gs: Gs): void {
    gs.mode = 'select';
    const b = clamp(align(xToBeat(gs.sx)), 0, songLen());
    const r = clamp(Math.floor(yToRow(gs.sy)), 0, Math.max(0, S.tracks.length - 1));
    selDrag = { b0: b, r0: r, b1: b, r1: r };
    S.clips.forEach(c => c.sel = false); S.sel = null; S.handles = false; hideAdd();
    invalidate();
  }
  function finishSelect(gs: Gs, q: Pt): void {
    const moved = Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr;
    const sd = selDrag; selDrag = null;
    if (!moved || !sd) { resetSel(); return; }
    const b0 = Math.min(sd.b0, sd.b1), b1 = Math.max(sd.b0, sd.b1);
    const r0 = Math.min(sd.r0, sd.r1), r1 = Math.max(sd.r0, sd.r1);
    let any: CL | null = null;
    for (const c of S.clips) {
      const row = trackIdx(c.track);
      const inT = (b1 - b0 < 1e-6) ? (c.beat <= b0 && c.beat + c.len > b0) : (c.beat < b1 && c.beat + c.len > b0);
      c.sel = inT && row >= r0 && row <= r1;
      if (c.sel && !any) any = c;
    }
    if (!any) { resetSel(); return; }
    S.cur = any.id; S.selTrack = any.track;
    S.sel = bound(selClips()); S.handles = true; invalidate();
  }

  function handleTap(q: Pt): void {
    const beat = xToBeat(q.x), row = Math.floor(yToRow(q.y));
    const hit = hitClip(q.x, q.y);
    const now = performance.now();
    if (hit) {
      if (lastTap && lastTap.id === hit.id && now - lastTap.t < 350) {   // double-tap: buka editor (piano roll)
        lastTap = null; selectOnly(hit); tapBeat = beat;
        opts.onOpenClip?.({ id: hit.id, track: hit.track, beat: hit.beat, len: hit.len, name: hit.name, notes: hit.notes.map(n => ({ ...n })), muted: hit.muted });
        return;
      }
      lastTap = { id: hit.id, t: now }; selectOnly(hit); tapBeat = beat; showClipPop(hit, q); return;
    }
    lastTap = null;
    if (row < 0 || row >= S.tracks.length || beat < 0) { resetSel(); hideAdd(); return; }
    const t = S.tracks[row];
    if (t.id !== S.selTrack) { resetSel(); S.selTrack = t.id; hideAdd(); invalidate(); return; }   // tap pertama hanya memilih baris
    if (addAt) { hideAdd(); return; }                                                               // tap lagi membatalkan tombol
    if (S.sel && S.handles) { resetSel(); return; }
    resetSel(); tapBeat = beat; showAdd(q, row);
  }

  function startPinch(a: Gs, b: Gs): void {
    clearTimeout(a.timer); selDrag = null;
    a.mode = 'pinch'; b.mode = 'pinch';
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinch = {
      a, b, dx0: Math.abs(a.x - b.x), dy0: Math.abs(a.y - b.y),
      zH0: S.zH, zV0: S.zV, mb: xToBeat(mx), mr: yToRow(my)
    };
  }
  function doPinch(): void {
    const { a, b } = pinch!;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (pinch!.dx0 >= 30 * dpr) S.zH = clamp(pinch!.zH0 * dx / pinch!.dx0, ZHMIN, ZHMAX);   // tiap sumbu dihitung sendiri
    if (pinch!.dy0 >= 30 * dpr) S.zV = clamp(pinch!.zV0 * dy / pinch!.dy0, ZVMIN, ZVMAX);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.posH = pinch!.mb - (mx - areaX) / pxBeat();
    S.posV = pinch!.mr - (my - areaY) / rowH();
    clampView(); syncZoomUI(); invalidate();
  }

  /* geser header: urutan track. track yang digeser mengikuti jari; lainnya bergeser memberi tempat */
  function reorderMove(gs: Gs, q: Pt): void {
    const n = S.tracks.length, t = gs.trk!;
    let r = gs.row0! + (q.y - gs.start!.y) / rowH();
    if (r < 0) r *= 0.05; else if (r > n - 1) r = n - 1 + (r - (n - 1)) * 0.05;   // efek karet di ujung
    t.disp = r; t.tgt = r;
    const drop = clamp(Math.round(r), 0, n - 1);
    gs.dropIdx = drop;
    let i = 0;
    for (const o of S.tracks) {
      if (o === t) continue;
      o.tgt = i < drop ? i : i + 1; i++;
    }
    invalidate();
  }
  function reorderEnd(gs: Gs): void {
    const t = gs.trk!, drop = gs.dropIdx ?? gs.row0!;
    dragTrack = null;
    const from = S.tracks.indexOf(t);
    if (from === drop) { cancelUndo(); S.tracks.forEach((o, i) => o.tgt = i); t.tgt = from; invalidate(); return; }
    S.tracks.splice(from, 1); S.tracks.splice(drop, 0, t);
    S.tracks.forEach((o, i) => o.tgt = i);
    S.sel = S.sel && selClips().length ? bound(selClips()) : null;
    touch();
  }

  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    closePop(); inertia = null; audio();
    const q = pt(e);
    const gs: Gs = { id: e.pointerId, x: q.x, y: q.y, sx: q.x, sy: q.y, t: performance.now(), mode: 'none', vx: 0, vy: 0 };
    if (ptrs.size === 1 && inArea(q.x, q.y)) {
      const o = [...ptrs.values()][0];
      if (['pending', 'pan', 'select'].includes(o.mode)) { ptrs.set(gs.id, gs); startPinch(o, gs); return; }
    }
    ptrs.set(gs.id, gs);
    if (ptrs.size > 1) { gs.mode = 'dead'; return; }

    const iw = Math.round(cell * HDR_CELLS);
    if (q.x < iw && q.y < rulerH) { gs.mode = 'corner'; togglePlay(); return; }
    if (q.y < rulerH) { gs.mode = 'ruler'; if (q.x >= areaX) seekTo(q.x); return; }
    if (q.x < areaX) {   // header track
      const row = Math.floor(yToRow(q.y));
      if (row < 0 || row > S.tracks.length) { gs.mode = 'dead'; return; }
      gs.mode = 'hdr'; gs.row = row; gs.start = q; gs.held = false; gs.moved = false;
      if (row < S.tracks.length) {   // tahan 0,2 detik: pilih track
        gs.timer = window.setTimeout(() => {
          if (gs.mode === 'hdr') { gs.held = true; S.selTrack = S.tracks[row].id; hideAdd(); invalidate(); }
        }, 200);
      }
      return;
    }
    if (!inArea(q.x, q.y)) { gs.mode = 'dead'; return; }
    if (S.sel && S.handles) {
      const hp = handlePos();
      for (const k of ['menu', 'move', 'resize'] as HandleKind[]) {
        const p = hp[k];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= cell * 0.6) {
          if (k === 'menu') { gs.mode = 'dead'; openMenu(p); } else beginDrag(gs, k, q);
          return;
        }
      }
    }
    const hit = hitClip(q.x, q.y);
    if (hit && hit.sel && S.sel) { beginDrag(gs, 'move', q); return; }
    gs.mode = 'pending';
    gs.timer = window.setTimeout(() => { if (gs.mode === 'pending') beginSelect(gs); }, 200);
  });

  cv.addEventListener('pointermove', e => {
    const gs = ptrs.get(e.pointerId); if (!gs) return;
    const q = pt(e);
    const now = performance.now();
    const px = gs.x, py = gs.y, pt0 = gs.lastT || gs.t;
    gs.x = q.x; gs.y = q.y;
    switch (gs.mode) {
      case 'pinch': doPinch(); break;
      case 'ruler': if (q.x >= areaX) seekTo(q.x); break;
      case 'drag': dragMove(gs, q); break;
      case 'hdr':
        if (gs.row! < S.tracks.length && Math.abs(q.y - gs.start!.y) > cell * 0.5) {   // lebih dari 0,5 cell: mulai geser urutan
          clearTimeout(gs.timer);
          saveUndo();
          gs.mode = 'reorder'; gs.trk = S.tracks[gs.row!]; gs.row0 = gs.trk.disp; gs.dropIdx = gs.row0;
          dragTrack = gs.trk; S.selTrack = gs.trk.id; hideAdd();
          reorderMove(gs, q);
        }
        break;
      case 'reorder': reorderMove(gs, q); break;
      case 'select':
        selDrag!.b1 = clamp(align(xToBeat(q.x)), 0, songLen());
        selDrag!.r1 = clamp(Math.floor(yToRow(q.y)), 0, Math.max(0, S.tracks.length - 1));
        invalidate(); break;
      case 'pending':
        if (Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr) {
          clearTimeout(gs.timer);
          gs.mode = 'pan'; gs.p0 = { x: q.x, y: q.y, h: S.posH, v: S.posV }; gs.vx = 0; gs.vy = 0;
        }
        break;
      case 'pan': {
        S.posH = gs.p0!.h - (q.x - gs.p0!.x) / pxBeat();
        S.posV = gs.p0!.v - (q.y - gs.p0!.y) / rowH();
        const dt = Math.max(1, now - pt0);
        gs.vx = 0.8 * ((q.x - px) / dt) + 0.2 * gs.vx;
        gs.vy = 0.8 * ((q.y - py) / dt) + 0.2 * gs.vy;
        gs.lastT = now;
        hideAdd(); clampView(); syncZoomUI(); invalidate(); break;
      }
    }
  });

  function endPointer(e: PointerEvent): void {
    const gs = ptrs.get(e.pointerId); if (!gs) return;
    ptrs.delete(e.pointerId);
    clearTimeout(gs.timer);
    const q = pt(e);
    switch (gs.mode) {
      case 'pending': handleTap(q); break;
      case 'select': finishSelect(gs, q); break;
      case 'pan':
        if (performance.now() - (gs.lastT || 0) < 60 && Math.hypot(gs.vx, gs.vy) > 0.05) inertia = { vx: gs.vx, vy: gs.vy };
        break;
      case 'drag': commitDrag(); break;
      case 'reorder': reorderEnd(gs); break;
      case 'hdr': {
        const row = gs.row!;
        if (row === S.tracks.length) addTrack();
        else if (!gs.held && S.tracks[row]) {
          if (S.tracks[row].id === S.selTrack) toggleMixer();   // pilih lagi baris aktif: buka/tutup header lebar
          else { S.selTrack = S.tracks[row].id; hideAdd(); }
        }
        break;
      }
      case 'pinch':
        pinch = null;
        for (const o of ptrs.values()) if (o.mode === 'pinch') o.mode = 'dead';
        break;
    }
    invalidate();
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------- Zoom / scroll ---------- */
  function syncZoomUI(): void {
    zhEl.value = String(toPos(S.zH, ZHMIN, ZHMAX));
    zvEl.value = String(toPos(S.zV, ZVMIN, ZVMAX));
  }
  function zoomAt(axis: 'h' | 'v', f: number, ax: number, ay: number): void {
    if (axis === 'h') {
      const b = xToBeat(ax); S.zH = clamp(S.zH * f, ZHMIN, ZHMAX);
      S.posH = b - (ax - areaX) / pxBeat();
    } else {
      const r = yToRow(ay); S.zV = clamp(S.zV * f, ZVMIN, ZVMAX);
      S.posV = r - (ay - areaY) / rowH();
    }
    hideAdd(); clampView(); syncZoomUI(); invalidate();
  }
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const q = pt(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.altKey ? 'v' : 'h', f, q.x, q.y);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      S.posH += (e.deltaX || e.deltaY) * dpr / pxBeat(); hideAdd(); clampView(); invalidate();
    } else {
      S.posV += e.deltaY * dpr / rowH(); hideAdd(); clampView(); invalidate();
    }
  }, { passive: false });
  zhEl.addEventListener('input', () => {
    const b = xToBeat(areaX + areaW / 2);
    S.zH = fromPos(+zhEl.value, ZHMIN, ZHMAX);
    S.posH = b - (areaW / 2) / pxBeat(); hideAdd(); clampView(); invalidate();
  });
  zvEl.addEventListener('input', () => {
    const r = yToRow(areaY + areaH / 2);
    S.zV = fromPos(+zvEl.value, ZVMIN, ZVMAX);
    S.posV = r - (areaH / 2) / rowH(); hideAdd(); clampView(); invalidate();
  });

  /* ---------- Toolbar & keyboard ---------- */
  function toggleMixer(): void { S.mxT = S.mxT ? 0 : 1; bMixer.classList.toggle('on', !!S.mxT); }
  function setTheme(name: 'light' | 'dark'): void {
    C = THEMES[name];
    for (const k in C.css) root.style.setProperty(k, C.css[k]);
    themeEl.value = name;
    invalidate();
  }
  themeEl.addEventListener('change', () => setTheme(themeEl.value as 'light' | 'dark'));
  bPlay.onclick = togglePlay;
  bMixer.onclick = toggleMixer;
  bAddTrack.onclick = addTrack;
  bPaste.onclick = pasteClip;
  bPaste.disabled = true;
  bpmEl.addEventListener('input', () => {
    S.bpm = clamp(+bpmEl.value || 120, 40, 240);
    if (playing) { const a = absNow(); playStartAbs = a; playT0 = ac!.currentTime; schedAbs = a; }
  });
  uiEl.addEventListener('change', () => { uiScale = +uiEl.value; hideAdd(); layout(); });
  snapSel.addEventListener('change', invalidate);
  bUndo.onclick = undo;
  bRedo.onclick = redo;

  const onKey = (e: KeyboardEvent): void => {
    const t = (e.target as HTMLElement | null)?.tagName;
    if (t === 'INPUT' || t === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'escape') { resetSel(); closePop(); hideAdd(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
    else if (mod && k === 'd') { e.preventDefault(); duplicateSel(); }
    else if (mod && k === 'c') { e.preventDefault(); copySel(); }
    else if (mod && k === 'x') { e.preventDefault(); cutSel(); }
    else if (mod && k === 'v') { e.preventDefault(); pasteClip(); }
    else if (k === 'm' && !mod) { toggleMute(); }
  };
  window.addEventListener('keydown', onKey);

  /* ---------- Loop render ---------- */
  let lastT = 0, raf = 0, dead = false;
  function frame(t: number): void {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, t - lastT); lastT = t;
    const k = 1 - Math.pow(0.6, dt / 16.7);   // ease-out 0,4 per tick, dipaku bila selisih < 0,05
    if (S.mx !== S.mxT) {
      S.mx += (S.mxT - S.mx) * k;
      if (Math.abs(S.mxT - S.mx) < 0.05) S.mx = S.mxT;
      layout();
    }
    for (const tr of S.tracks) {
      if (tr === dragTrack || tr.disp === tr.tgt) continue;
      tr.disp += (tr.tgt - tr.disp) * k;
      if (Math.abs(tr.tgt - tr.disp) < 0.05) tr.disp = tr.tgt;
      dirty = true;
    }
    if (inertia) {
      S.posH -= inertia.vx * dt / pxBeat();
      S.posV -= inertia.vy * dt / rowH();
      const f = Math.pow(0.95, dt / 16.7);
      inertia.vx *= f; inertia.vy *= f;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.02) inertia = null;
      clampView(); syncZoomUI(); dirty = true;
    }
    if (playing && !ptrs.size) {   // ikuti playhead: gulung layar bila playhead keluar dari tampilan
      const ph = curBeat(), vb = areaW / pxBeat();
      if (ph < S.posH || ph > S.posH + vb * 0.95) { S.posH = ph; clampView(); syncZoomUI(); }
    }
    if (updateLevels()) dirty = true;
    if (dirty || playing) { dirty = false; draw(); }
  }

  /* ---------- Init ---------- */
  const init = opts.tracks ? { tracks: opts.tracks, clips: opts.clips ?? [] } : demoState();
  loadState(init);
  bpmEl.value = String(S.bpm);
  setTheme(opts.theme ?? 'dark');
  syncZoomUI(); updUndo();
  resize();
  raf = requestAnimationFrame(frame);

  /* ---------- Handle ---------- */
  const exportState = (): PlaylistState => ({
    tracks: S.tracks.map(t => ({ id: t.id, name: t.name, color: t.color })),
    clips: S.clips.map(c => ({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted })),
    view: { posH: S.posH, posV: S.posV, zH: S.zH, zV: S.zV }
  });
  return {
    destroy(): void {
      dead = true;
      cancelAnimationFrame(raf);
      stopPlay();
      for (const g of ptrs.values()) clearTimeout(g.timer);
      ptrs.clear();
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      if (ac) { void ac.close(); ac = null; master = null; }
      root.remove();
    },
    getState: exportState,
    setState(s: PlaylistState): void {
      loadState(s); undoS.length = 0; redoS.length = 0; updUndo();
      hideAdd(); clampView(); syncZoomUI(); touch();
    },
    setClipNotes(clipId: number, notes: PLNote[]): void {   // dipakai setelah piano roll selesai mengedit clip
      const c = S.clips.find(x => x.id === clipId); if (!c) return;
      c.notes = notes.map(n => ({ ...n })); touch();
    },
    resize,
    stop(): void { stopPlay(); }
  };
}
