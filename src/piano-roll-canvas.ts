// Piano roll berbasis canvas (hasil konversi dari piano-roll.html tunggal jadi komponen).
// Isinya sama persis dengan versi HTML: toolbar, grid, keyboard, ruler, velocity lane, seleksi + handle, undo/redo, copy/paste, zoom, pan inersia, pinch.
// Semua state ada di dalam closure mountPianoRoll(), jadi bisa dipasang lebih dari satu instance dan dibersihkan lewat destroy().
// Audio masih punya AudioContext sendiri (sama seperti versi HTML); belum disambung ke audio-engine.ts.

import './piano-roll-canvas.css';

export interface PRNote { key: number; beat: number; len: number; vel: number; }   // key = nomor MIDI 0..127, beat & len dalam ketukan, vel 1..255
export interface PianoRollCanvasOpts {
  notes?: PRNote[];
  clipLen?: number;            // panjang clip (ketukan), default 32
  bpm?: number;                // default 120
  theme?: 'light' | 'dark';    // default 'light'
  color?: string;              // warna note, default oranye
  clipOffset?: number;         // posisi awal clip di timeline (ketukan), default 0; snap dihitung relatif ke sini
  onChange?: () => void;       // dipanggil setelah note berubah (setelah gesture, menu, undo/redo, keyboard)
  onTransport?: (playing: boolean) => void;   // dipanggil saat play/stop
}
export interface PianoRollCanvasHandle {
  destroy(): void;
  getNotes(): PRNote[];
  setNotes(notes: PRNote[]): void;
  resize(): void;
  setClipOffset(beats: number): void;
  setClipLen(beats: number): void;
  setColor(color: string): void;
  stop(): void;
}

interface N extends PRNote { sel: boolean; }
interface Sel { beat: number; row: number; len: number; rows: number; }
interface Pt { x: number; y: number; }
type DragType = 'move' | 'resize' | 'stretch';
interface Drag { type: DragType; dBeat: number; dRow: number; dLen: number; scale: number; }
interface SelDrag { b0: number; r0: number; b1: number; r1: number; }
interface Voice { stop(at?: number): void; }
interface Gs {
  id: number; x: number; y: number; sx: number; sy: number; t: number; mode: string;
  vx: number; vy: number; timer?: number; lastT?: number; p0?: { x: number; y: number; h: number; v: number };
  key?: number; vel?: number; changed?: boolean; last?: Pt;
  type?: DragType; s0?: Sel; start?: Pt; minBeat?: number; maxBeat?: number; minRow?: number; maxRow?: number; pv?: number | null;
  b0?: number; r0?: number;
}
interface Pinch { a: Gs; b: Gs; dx0: number; dy0: number; zH0: number; zV0: number; mb: number; mr: number; }

/* ---------- Token ---------- */
interface Theme {
  bg: string; rb: string; rw: string; rule: string; light: string;
  lat: string; latA: [number, number, number]; octLine: string; rowLine: string | null; rowText: string;
  noteLine: string; noteText: string | null; selFill: string;
  keyBg: string; keyW: string; keyB: string; keySep: string;
  rulerBg: string; rulerSel: string; tick: string; circle: string; circleText: string;
  selBorder: string; selBox: string; handleBg: string; handleFg: string;
  playhead: string; playShadow: string; playW: number;
  velSep: string; velBg: string; velLine: string; shadow: string;
  css: Record<string, string>;
}
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {   // FLM Studio Mobile
    bg: '#21272B', rb: '#31373B', rw: '#394046', rule: '#434C51', light: '#C7CEDA',
    lat: '#21272B', latA: [1, 1, 1], octLine: '#21272B', rowLine: null, rowText: 'rgba(199,206,218,.4)',
    noteLine: 'rgba(33,39,43,.3)', noteText: null, selFill: '#C7CEDA',
    keyBg: '#21272B', keyW: '#C7CEDA', keyB: '#394046', keySep: 'rgba(33,39,43,.3)',
    rulerBg: '#21272B', rulerSel: '#394046', tick: '#434C51', circle: '#C7CEDA', circleText: '#21272B',
    selBorder: '#C7CEDA', selBox: 'rgba(199,206,218,.2)', handleBg: '#C7CEDA', handleFg: '#21272B',
    playhead: '#C7CEDA', playShadow: 'rgba(33,39,43,.3)', playW: 2,
    velSep: '#21272B', velBg: '#31373B', velLine: 'rgba(0,0,0,.2)', shadow: 'rgba(0,0,0,.15)',
    css: { '--bg-dark': '#21272B', '--row-black': '#31373B', '--row-white': '#394046', '--rule': '#434C51', '--light': '#C7CEDA' }
  },
  light: {  // terang, gaya screenshot (baris abu-abu, note oranye + label)
    bg: '#B4B4B4', rb: '#B1B1B1', rw: '#C9C9C9', rule: '#8A8A8A', light: '#222222',
    lat: '#000000', latA: [.08, .15, .35], octLine: 'rgba(0,0,0,.35)', rowLine: 'rgba(0,0,0,.07)', rowText: 'rgba(0,0,0,.35)',
    noteLine: '#3B2808', noteText: '#3B2808', selFill: '#FFD84A',
    keyBg: '#8A8A8A', keyW: '#F1F1F1', keyB: '#2E2E2E', keySep: 'rgba(0,0,0,.35)',
    rulerBg: '#D2D2D2', rulerSel: '#B8B8B8', tick: '#7C7C7C', circle: '#2A2A2A', circleText: '#F1F1F1',
    selBorder: '#2A2A2A', selBox: 'rgba(0,0,0,.12)', handleBg: '#2A2A2A', handleFg: '#F1F1F1',
    playhead: '#1A1A1A', playShadow: 'rgba(255,255,255,.35)', playW: 1,
    velSep: '#9A9A9A', velBg: '#BDBDBD', velLine: 'rgba(0,0,0,.1)', shadow: 'rgba(0,0,0,.12)',
    css: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
  }
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACKMASK = 0x54a;
const isBlack = (k: number): number => (BLACKMASK >> (k % 12)) & 1;
const MINLEN = 0.125;
const U = 1;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
const ZHMIN = 0.5, ZHMAX = 40, ZVMIN = 1 / 6, ZVMAX = 4;
const toPos = (v: number, mn: number, mx: number): number => Math.round(100 * Math.log(v / mn) / Math.log(mx / mn));
const fromPos = (p: number, mn: number, mx: number): number => mn * Math.pow(mx / mn, p / 100);

const TEMPLATE = `
<div class="prc-bar">
  <button data-r="play">Play</button>
  <label>BPM <input data-r="bpm" type="number" min="40" max="240" value="120"></label>
  <label>Snap
    <select data-r="snap">
      <option value="auto">Otomatis</option>
      <option value="off">Tanpa snap</option>
      <option value="1/8">1/2 Step</option>
      <option value="1/6">1/6 Beat</option>
      <option value="1/4">1/4 Beat</option>
      <option value="1/3">1/3 Beat</option>
      <option value="1/2">1/2 Beat</option>
      <option value="1">1 Beat</option>
      <option value="4">1 Bar</option>
    </select>
  </label>
  <label>Tema
    <select data-r="theme">
      <option value="light">Terang</option>
      <option value="dark">Gelap (FLM)</option>
    </select>
  </label>
  <label>Warna
    <select data-r="color">
      <option value="#F5A12A">Oranye</option>
      <option value="#4FA8E8">Biru</option>
      <option value="#5BC77A">Hijau</option>
      <option value="#E8605A">Merah</option>
      <option value="#A678E8">Ungu</option>
      <option value="#E6D24F">Kuning</option>
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
  <button data-r="vel">Velocity</button>
  <button data-r="undo">Undo</button>
  <button data-r="redo">Redo</button>
  <button data-r="clear">Kosongkan</button>
  <span class="prc-hint">Tap: buat note &middot; Tahan 0,2 dtk: seleksi area &middot; Geser: scroll &middot; Pinch / Ctrl+scroll: zoom</span>
</div>
<div class="prc-stage">
  <canvas class="prc-cv"></canvas>
  <div class="prc-pop"></div>
</div>`;

// nada contoh dari versi HTML (progresi 4 akor, 8 bar) — dipakai kalau mau lihat tampilannya: mountPianoRoll(host, { notes: demoNotes() })
export function demoNotes(): PRNote[] {
  const out: PRNote[] = [];
  const chords = [[60, 63, 67], [56, 60, 63], [63, 67, 70], [58, 62, 65]];
  for (let bar = 0; bar < 8; bar++) {
    const ch = chords[bar % 4], b = bar * 4;
    out.push({ key: ch[0] - 24, beat: b, len: 2, vel: 200 });
    for (let i = 0; i < 8; i++) {
      out.push({ key: ch[i % 3] + (i % 6 >= 3 ? 12 : 0), beat: b + i * 0.5, len: 0.5, vel: i % 4 === 0 ? 210 : 150 });
    }
  }
  return out;
}

export function mountPianoRoll(host: HTMLElement, opts: PianoRollCanvasOpts = {}): PianoRollCanvasHandle {
  const root = document.createElement('div');
  root.className = 'prc';
  root.innerHTML = TEMPLATE;
  host.appendChild(root);

  const $ = <T extends HTMLElement>(r: string): T => root.querySelector<T>(`[data-r="${r}"]`)!;
  const cv = root.querySelector<HTMLCanvasElement>('.prc-cv')!;
  const ctx = cv.getContext('2d')!;
  const stage = root.querySelector<HTMLElement>('.prc-stage')!;
  const pop = root.querySelector<HTMLElement>('.prc-pop')!;
  const bPlay = $<HTMLButtonElement>('play'), bVel = $<HTMLButtonElement>('vel');
  const bUndo = $<HTMLButtonElement>('undo'), bRedo = $<HTMLButtonElement>('redo'), bClear = $<HTMLButtonElement>('clear');
  const snapSel = $<HTMLSelectElement>('snap'), themeEl = $<HTMLSelectElement>('theme'), colorEl = $<HTMLSelectElement>('color');
  const uiEl = $<HTMLSelectElement>('ui'), bpmEl = $<HTMLInputElement>('bpm');
  const zhEl = $<HTMLInputElement>('zh'), zvEl = $<HTMLInputElement>('zv');

  let C: Theme = THEMES.light;

  /* ---------- State ---------- */
  const S = {
    notes: [] as N[], clipLen: opts.clipLen ?? 32, spb: 4, bpb: 4, bpm: opts.bpm ?? 120,
    zH: 4, zV: 0.75, posH: 0, posV: 51,
    color: opts.color ?? '#F5A12A', lastLen: 1, lastVel: 0.7, clipOffset: opts.clipOffset ?? 0,
    sel: null as Sel | null, handles: false
  };
  let clipboard: PRNote[] = [];
  let drag: Drag | null = null;          // preview drag
  let selDrag: SelDrag | null = null;    // kotak seleksi yang sedang digambar
  let inertia: { vx: number; vy: number } | null = null;
  let dirty = true;
  const invalidate = (): void => { dirty = true; };
  let lastSnap = '';
  const notify = (): void => {   // beri tahu host hanya bila isi note benar-benar berubah
    const s = JSON.stringify(S.notes.map(n => [n.key, n.beat, n.len, n.vel]));
    if (s === lastSnap) return;
    lastSnap = s; opts.onChange?.();
  };

  let W = 0, H = 0, dpr = 1, cell = 24, V = 2, uiScale = 1;
  let kbW = 0, rulerH = 0, areaX = 0, areaY = 0, areaW = 0, areaH = 0, velOn = false, velY = 0, velH = 0;

  const toN = (n: PRNote): N => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel, sel: false });

  /* ---------- Tata letak ---------- */
  function layout(): void {
    cell = Math.max(16, Math.round(24 * uiScale * dpr));
    V = Math.max(1, Math.round(cell / 16));
    kbW = Math.round(cell * 2.5);
    rulerH = Math.round(cell * 1.5);
    areaX = kbW; areaY = rulerH; areaW = Math.max(10, W - kbW);
    const tot = Math.max(10, H - rulerH);
    if (velOn) {
      velH = Math.min(Math.max(Math.round(tot * 0.28), Math.round(cell * 2)), Math.round(tot * 0.6));
      areaH = tot - velH - 4 * U;
      velY = areaY + areaH + 4 * U;
    } else {
      velH = 0; areaH = tot; velY = areaY + areaH;
    }
    clampView();
    invalidate();
  }
  const pxBeat = (): number => S.zH * cell;
  const rowH = (): number => S.zV * cell;
  const bx = (b: number): number => areaX + (b - S.posH) * pxBeat();
  const ry = (r: number): number => areaY + (r - S.posV) * rowH();
  const xToBeat = (x: number): number => (x - areaX) / pxBeat() + S.posH;
  const yToRow = (y: number): number => (y - areaY) / rowH() + S.posV;

  function clampView(): void {
    const vr = areaH / rowH();
    S.posV = clamp(S.posV, 0, Math.max(0, 128 - vr));
    const vb = areaW / pxBeat();
    S.posH = clamp(S.posH, 0, Math.max(0, S.clipLen - vb * 0.25));
  }

  function resize(): void {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(50, Math.round(r.width * dpr)); cv.height = Math.max(50, Math.round(r.height * dpr));
    W = cv.width; H = cv.height;   // semua koordinat dalam piksel perangkat asli (tajam, tanpa scaling)
    layout();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  /* ---------- Snap & lattice ---------- */
  function latticeStep(): number {
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
    const off = S.clipOffset;   // snap relatif awal clip, bukan awal timeline
    return r6(Math[mode]((b + off) / st + 1e-9) * st - off);
  }
  function kind(b: number): number {
    if (near(b / S.bpb)) return 2;
    if (near(b)) return 1;
    return 0;
  }

  /* ---------- Audio ---------- */
  let ac: AudioContext | null = null, master: GainNode | null = null;
  function audio(): AudioContext {
    if (!ac) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ac = new Ctor();
      master = ac.createGain(); master.gain.value = 0.8;
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
  const held = new Map<number, Voice>();
  const flashKeys = new Set<number>();
  const flashTimers = new Set<number>();
  function flash(key: number, vel: number): void {
    voice(key, vel, null, 0.25);
    flashKeys.add(key); invalidate();
    const id = window.setTimeout(() => { flashTimers.delete(id); flashKeys.delete(key); invalidate(); }, 250);
    flashTimers.add(id);
  }
  function pressed(): Set<number> {
    const s = new Set<number>(held.keys());
    flashKeys.forEach(k => s.add(k));
    if (playing) {
      const ph = curBeat();
      for (const n of S.notes) if (ph >= n.beat && ph < n.beat + n.len) s.add(n.key);
    }
    return s;
  }

  /* ---------- Transport ---------- */
  let playing = false, playStartAbs = 0, playT0 = 0, schedAbs = 0, timer: number | null = null, playhead = 0;
  let live: Voice[] = [];
  function curBeat(): number {
    if (!playing) return playhead;
    const abs = playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60;
    return ((abs % S.clipLen) + S.clipLen) % S.clipLen;
  }
  function absNow(): number { return playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60; }
  function scheduler(): void {
    if (!playing) return;
    const bps = S.bpm / 60;
    const A = schedAbs, B = absNow() + 0.15 * bps;
    if (B <= A) return;
    const L = S.clipLen;
    const k0 = Math.floor(A / L), k1 = Math.floor(B / L);
    for (let k = k0; k <= k1; k++) {
      for (const n of S.notes) {
        const nb = n.beat + k * L;
        if (nb >= A && nb < B) {
          const when = Math.max(playT0 + (nb - playStartAbs) / bps, ac!.currentTime);
          live.push(voice(n.key, n.vel / 255, when, n.len / bps));
        }
      }
    }
    if (live.length > 200) live = live.slice(-100);
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
    playing = false; if (timer != null) clearInterval(timer); timer = null;
    live.forEach(v => v.stop()); live = [];
    bPlay.textContent = 'Play'; bPlay.classList.remove('on'); invalidate();
    if (was) opts.onTransport?.(false);
  }
  function togglePlay(): void { playing ? stopPlay() : startPlay(); }
  function seekTo(x: number): void {
    const ls = latticeStep();
    const b = clamp(Math.round(xToBeat(x) / ls) * ls, 0, S.clipLen);
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; }
    else playhead = b;
    invalidate();
  }

  /* ---------- Undo ---------- */
  const undoS: string[] = [], redoS: string[] = [];
  const snapshot = (): string => JSON.stringify(S.notes.map(n => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel })));
  function updUndo(): void {
    bUndo.disabled = !undoS.length;
    bRedo.disabled = !redoS.length;
  }
  function saveUndo(): void { undoS.push(snapshot()); if (undoS.length > 200) undoS.shift(); redoS.length = 0; updUndo(); }
  function cancelUndo(): void { undoS.pop(); updUndo(); }
  function loadSnap(s: string): void {
    S.notes = (JSON.parse(s) as PRNote[]).map(toN);
    resetSel(); updUndo(); invalidate();
  }
  function undo(): void { if (!undoS.length) return; redoS.push(snapshot()); loadSnap(undoS.pop()!); }
  function redo(): void { if (!redoS.length) return; undoS.push(snapshot()); loadSnap(redoS.pop()!); }

  /* ---------- Seleksi ---------- */
  function bound(arr: PRNote[]): Sel {
    const minB = Math.min(...arr.map(n => n.beat));
    const maxE = Math.max(...arr.map(n => n.beat + n.len));
    const minR = Math.min(...arr.map(n => 127 - n.key));
    const maxR = Math.max(...arr.map(n => 127 - n.key));
    return { beat: minB, row: minR, len: maxE - minB, rows: maxR - minR + 1 };
  }
  function resetSel(): void { S.notes.forEach(n => n.sel = false); S.sel = null; S.handles = false; selDrag = null; invalidate(); }
  function selectOnly(n: N): void {
    S.notes.forEach(x => x.sel = false); n.sel = true;
    S.sel = bound([n]); S.handles = true; invalidate();
  }
  const selNotes = (): N[] => S.notes.filter(n => n.sel);
  function refreshSel(): void {
    const a = selNotes();
    if (!a.length) resetSel();
    invalidate();
  }

  /* ---------- Note: koordinat tunggal ---------- */
  function shifted(n: N): { beat: number; row: number; len: number } {
    let beat = n.beat, row = 127 - n.key, len = n.len;
    if (drag && n.sel) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else if (drag.type === 'resize') { len = Math.max(MINLEN, len + drag.dLen); }
      else if (drag.type === 'stretch') {
        const a = S.sel!.beat;
        beat = a + (beat - a) * drag.scale; len = Math.max(MINLEN, len * drag.scale);
      }
    }
    return { beat, row, len };
  }
  function noteRectPx(n: N): { x: number; y: number; w: number; h: number; s: { beat: number; row: number; len: number } } {
    const s = shifted(n);
    const x0 = Math.round(bx(s.beat)), x1 = Math.round(bx(s.beat + s.len));
    const y0 = Math.round(ry(s.row)), y1 = Math.round(ry(s.row + 1));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, s };
  }
  function selDisp(): Sel | null {
    const s = S.sel; if (!s) return null;
    let { beat, row, len, rows } = s;
    if (drag) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else if (drag.type === 'resize') len = Math.max(MINLEN, len + drag.dLen);
      else if (drag.type === 'stretch') len = Math.max(MINLEN, len * drag.scale);
    }
    return { beat, row, len, rows };
  }
  function hitNote(x: number, y: number): N | null {
    for (let i = S.notes.length - 1; i >= 0; i--) {
      const n = S.notes[i], r = noteRectPx(n);
      if (x >= r.x && x < r.x + Math.max(r.w, 8 * dpr) && y >= r.y && y < r.y + r.h) return n;
    }
    return null;
  }

  /* ---------- Menggambar ---------- */
  function drawLattice(y: number, h: number): void {
    const ls = latticeStep(), pb = pxBeat();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    ctx.fillStyle = C.lat;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls, x = bx(b), kd = kind(b);
      const w = kd === 2 ? 4 * U : kd === 1 ? 2 * U : U;
      const off = kd === 2 ? 2 * U : U;
      ctx.globalAlpha = C.latA[kd];
      ctx.fillRect(Math.round(x - off), y, w, h);
    }
    ctx.globalAlpha = 1;
  }
  function drawShadow(y: number, h: number): void {
    const x = bx(S.clipLen);
    if (x < areaX + areaW) {
      const x0 = Math.max(areaX, Math.round(x));
      ctx.fillStyle = C.shadow;
      ctx.fillRect(x0, y, areaX + areaW - x0, h);
    }
  }
  function drawClipBox(P: Set<number>): void {
    const rh = rowH();
    const r0 = Math.max(0, Math.floor(S.posV)), r1 = Math.min(127, Math.ceil(S.posV + areaH / rh));
    const cx0 = Math.max(areaX, Math.round(bx(0))), cx1 = Math.min(areaX + areaW, Math.round(bx(S.clipLen)));
    const yEnd = Math.min(areaY + areaH, Math.round(ry(128)));
    if (cx1 > cx0) {
      ctx.fillStyle = C.rb; ctx.fillRect(cx0, areaY, cx1 - cx0, yEnd - areaY);
    }
    const allNames = rh > cell * 0.6, cNames = rh > cell * 0.3;
    ctx.font = Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (let r = r0; r <= r1; r++) {
      const key = 127 - r, y0 = Math.round(ry(r)), y1 = Math.round(ry(r + 1));
      if (cx1 > cx0) {
        if (!isBlack(key)) { ctx.fillStyle = C.rw; ctx.fillRect(cx0, y0, cx1 - cx0, y1 - y0); }
        if (P.has(key)) { ctx.globalAlpha = .1; ctx.fillStyle = S.color; ctx.fillRect(cx0, y0, cx1 - cx0, y1 - y0); ctx.globalAlpha = 1; }
        if (C.rowLine) { ctx.fillStyle = C.rowLine; ctx.fillRect(cx0, y1 - U, cx1 - cx0, U); }
        if (key % 12 === 0) { ctx.fillStyle = C.octLine; ctx.fillRect(cx0, y1 - 2 * U, cx1 - cx0, 2 * U); }
      }
      const isC = key % 12 === 0;
      if (allNames || (cNames && isC)) {
        ctx.fillStyle = C.rowText;
        const txt = isC ? NAMES[0] + Math.floor(key / 12) : NAMES[key % 12];
        ctx.fillText(txt, areaX + 11 + V, (y0 + y1) / 2);
      }
    }
    drawLattice(areaY, areaH);
  }
  function drawNotes(): void {
    const ph = playing ? curBeat() : -1;
    for (const n of S.notes) {
      const r = noteRectPx(n);
      if (r.x + r.w < areaX || r.x > areaX + areaW || r.y + r.h < areaY || r.y > areaY + areaH) continue;
      let { x, y, w, h } = r;
      if (y < areaY) { h -= areaY - y; y = areaY; }
      w = Math.max(w, U); h = Math.max(1, h - 2 * U);
      const on = n.sel || (playing && ph >= n.beat && ph < n.beat + n.len);
      const o = C.noteText ? Math.max(1, Math.round(dpr)) : 1;
      ctx.fillStyle = C.noteLine; ctx.fillRect(x - o, y - o, w + 2 * o, h + 2 * o);
      ctx.fillStyle = on ? C.selFill : S.color; ctx.fillRect(x, y, w, h);
      if (C.noteText && w > 14 * dpr && h > 9 * dpr) {
        const key = 127 - Math.round(r.s.row), t = NAMES[key % 12] + Math.floor(key / 12);
        ctx.font = 'bold ' + Math.round(cell * 0.34) + 'px system-ui,sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        if (ctx.measureText(t).width + 6 * dpr <= w) { ctx.fillStyle = C.noteText; ctx.fillText(t, x + 3 * dpr, y + h / 2 + 1); }
      }
    }
  }
  function drawKeyboard(P: Set<number>): void {
    const rh = rowH();
    const r0 = Math.max(0, Math.floor(S.posV)), r1 = Math.min(127, Math.ceil(S.posV + areaH / rh));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, areaY, kbW, areaH); ctx.clip();
    ctx.fillStyle = C.keyBg; ctx.fillRect(0, areaY, kbW, areaH);
    const x = -11 * U, w = kbW + 10 * U;
    for (let r = r0; r <= r1; r++) {
      const key = 127 - r, y0 = Math.round(ry(r)), y1 = Math.round(ry(r + 1)), h = y1 - y0;
      if (P.has(key)) {
        ctx.fillStyle = C.keySep; ctx.fillRect(x, y0 - 1, w, h + 2);
        ctx.fillStyle = S.color; ctx.fillRect(x, y0, w, h);
      } else if (isBlack(key)) {
        ctx.fillStyle = C.keyB; ctx.fillRect(x, y0, w, h);
      } else {
        ctx.fillStyle = C.keySep; ctx.fillRect(x, y0 - 1, w, h + 2);
        ctx.fillStyle = C.keyW; ctx.fillRect(x, y0, w, h);
      }
    }
    ctx.restore();
  }
  function drawRuler(): void {
    const pb = pxBeat();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, 0, areaW, rulerH); ctx.clip();
    ctx.fillStyle = C.rulerBg; ctx.fillRect(areaX, 0, areaW, rulerH);
    const cx = Math.round(bx(0));
    ctx.fillStyle = S.color; ctx.fillRect(cx, 0, 2 * U, Math.round(rulerH * 0.3));
    const sd = selDisp();
    if (sd) {
      const x0 = Math.round(bx(sd.beat)), x1 = Math.round(bx(sd.beat + sd.len));
      ctx.fillStyle = C.rulerSel; ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), rulerH);
    }
    const ls = latticeStep();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    ctx.fillStyle = C.tick;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls, x = bx(b), kd = kind(b);
      const h = Math.round(rulerH * (kd ? 0.3 : 0.2));
      const w = kd === 2 ? 2 * V : V;
      ctx.fillRect(Math.round(x - w / 2), rulerH - h, w, h);
    }
    // nomor bar
    let m = 1; while (S.bpb * m * pb < cell * 1.6) m *= 2;
    const i0 = Math.floor(S.posH / (S.bpb * m)), i1 = Math.ceil((S.posH + areaW / pb) / (S.bpb * m));
    ctx.font = 'bold ' + Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = i0; i <= i1; i++) {
      const b = i * S.bpb * m; if (b < 0 || b >= S.clipLen) continue;
      const x = bx(b), ccx = x + 6 * V + U, ccy = rulerH * 0.38;
      ctx.fillStyle = C.circle; ctx.beginPath(); ctx.arc(ccx, ccy, 6 * V, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.circleText; ctx.fillText(String(i * m + 1), ccx, ccy + 1);
    }
    ctx.fillStyle = C.tick; ctx.fillRect(areaX, rulerH - V, areaW, V);
    if (sd) {
      const x0 = Math.round(bx(sd.beat)), x1 = Math.round(bx(sd.beat + sd.len));
      ctx.fillStyle = S.color;
      ctx.fillRect(x0, 0, 2 * U, Math.round(rulerH * 0.5));
      ctx.fillRect(x1 - 2 * U, 0, 2 * U, Math.round(rulerH * 0.5));
    }
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
  type HandleKind = 'move' | 'menu' | 'resize' | 'stretch';
  function handlePos(): Record<HandleKind, Pt> {
    const sd = selDisp()!, r = cell * 0.45;
    const x0 = bx(sd.beat), x1 = bx(sd.beat + sd.len), y0 = ry(sd.row), y1 = ry(sd.row + sd.rows);
    const cl = (p: Pt): Pt => ({ x: clamp(p.x, areaX + r, areaX + areaW - r), y: clamp(p.y, areaY + r, areaY + areaH - r) });
    return {
      move: cl({ x: (x0 + x1) / 2, y: y1 + cell * 0.75 }),
      menu: cl({ x: (x0 + x1) / 2, y: y0 - cell * 0.8 }),
      resize: cl({ x: x1 + cell * 0.65, y: (y0 + y1) / 2 }),
      stretch: cl({ x: x1 + cell * 0.65, y: y1 + cell * 0.65 })
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
    } else if (kindName === 'stretch') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
      ctx.moveTo(p.x - a, p.y - a * .7); ctx.lineTo(p.x - a, p.y + a * .7);
      ctx.moveTo(p.x + a, p.y - a * .7); ctx.lineTo(p.x + a, p.y + a * .7);
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
        drawHandle('menu', hp.menu); drawHandle('move', hp.move);
        drawHandle('resize', hp.resize); drawHandle('stretch', hp.stretch);
      }
    }
    ctx.restore();
  }
  function drawPlayhead(): void {
    const ph = curBeat();
    if (!playing && (ph < 0 || ph > S.clipLen)) return;
    const x = Math.round(bx(ph));
    if (x < areaX || x > areaX + areaW) return;
    const pw = Math.max(U, Math.round(C.playW * V)), h0 = Math.floor(pw / 2);
    ctx.fillStyle = C.playShadow; ctx.fillRect(x - h0 - U, 0, pw + 2 * U, areaY + areaH);
    ctx.fillStyle = C.playhead; ctx.fillRect(x - h0, 0, pw, areaY + areaH);
  }
  function drawVel(): void {
    if (!velOn) return;
    ctx.fillStyle = C.velSep; ctx.fillRect(0, velY - 4 * U, W, velH + 4 * U);
    ctx.fillStyle = S.color; ctx.fillRect(0, velY - 3 * U, W, 2 * U);
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, velY, areaW, velH); ctx.clip();
    ctx.fillStyle = C.velBg; ctx.fillRect(areaX, velY, areaW, velH);
    ctx.fillStyle = C.velLine;
    for (let i = 0; i < 10; i++) ctx.fillRect(areaX, Math.round(velY + i * 0.1 * velH), areaW, U);
    drawLattice(velY, velH);
    drawShadow(velY, velH);
    const bottom = velY + velH;
    for (const pass of [false, true]) {
      for (const n of S.notes) {
        if (n.sel !== pass) continue;
        const s = shifted(n);
        const x = Math.round(bx(s.beat)), w = Math.max(Math.round(s.len * pxBeat()), 4 * U);
        if (x + w < areaX || x > areaX + areaW) continue;
        const top = Math.round(bottom - (n.vel / 255) * velH);
        ctx.fillStyle = n.sel ? C.selFill : S.color;
        ctx.fillRect(x, top, 4 * U, bottom - top);
        ctx.fillRect(x, top, w, 2 * U);
      }
    }
    ctx.restore();
  }
  function drawCorner(): void {
    ctx.fillStyle = C.rulerBg; ctx.fillRect(0, 0, kbW, rulerH);
    const cx = kbW / 2, cy = rulerH / 2, r = Math.min(kbW, rulerH) * 0.38;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.handleFg;
    if (playing) { const a = r * 0.45; ctx.fillRect(cx - a, cy - a, a * 2, a * 2); }
    else {
      const a = r * 0.5;
      ctx.beginPath(); ctx.moveTo(cx - a * 0.6, cy - a); ctx.lineTo(cx + a, cy); ctx.lineTo(cx - a * 0.6, cy + a); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = C.tick; ctx.fillRect(0, rulerH - V, kbW, V);
  }
  function draw(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const P = pressed();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    drawClipBox(P);
    drawShadow(areaY, areaH);
    drawNotes();
    ctx.restore();
    drawKeyboard(P);
    drawRuler();
    drawSelector();
    drawPlayhead();
    drawVel();
    drawCorner();
  }

  /* ---------- Operasi note ---------- */
  function createNote(beat: number, row: number): void {
    saveUndo();
    const b = clamp(align(beat, 'floor'), 0, S.clipLen - MINLEN);
    const n: N = { key: 127 - row, beat: b, len: Math.min(S.lastLen, S.clipLen - b), vel: Math.round(S.lastVel * 255), sel: false };
    S.notes.push(n);
    flash(n.key, S.lastVel);
    invalidate();
  }
  function deleteSel(): void {
    if (!selNotes().length) return;
    saveUndo();
    S.notes = S.notes.filter(n => !n.sel);
    resetSel();
  }
  function copySel(): void {
    const a = selNotes(); if (!a.length) return;
    const minB = Math.min(...a.map(n => n.beat));
    clipboard = a.map(n => ({ key: n.key, beat: n.beat - minB, len: n.len, vel: n.vel }));
  }
  function pasteAt(beat: number): void {
    if (!clipboard.length) return;
    saveUndo();
    S.notes.forEach(n => n.sel = false);
    const added: N[] = [];
    for (const c of clipboard) {
      const nb = r6(beat + c.beat);
      if (nb >= S.clipLen) continue;
      const n: N = { key: c.key, beat: nb, len: Math.min(c.len, S.clipLen - nb), vel: c.vel, sel: true };
      S.notes.push(n); added.push(n);
    }
    if (!added.length) { cancelUndo(); return; }
    S.sel = bound(added); S.handles = true; invalidate();
  }
  function duplicateSel(): void {
    const a = selNotes(); if (!a.length || !S.sel) return;
    const l = S.sel.len > 0 ? S.sel.len : 1;
    saveUndo();
    const added: N[] = [];
    for (const n of a) {
      const nb = r6(n.beat + l); n.sel = false;
      if (nb >= S.clipLen) continue;
      const c: N = { key: n.key, beat: nb, len: Math.min(n.len, S.clipLen - nb), vel: n.vel, sel: true };
      S.notes.push(c); added.push(c);
    }
    if (!added.length) { resetSel(); return; }
    S.sel = { ...S.sel, beat: r6(S.sel.beat + l) }; S.handles = true; invalidate();
  }
  function insertSpace(): void {
    if (!S.sel || S.sel.len <= 0) return;
    saveUndo();
    const s = S.sel.beat, l = S.sel.len;
    for (const n of S.notes) if (n.beat >= s - 1e-9) n.beat = r6(n.beat + l);
    S.notes = S.notes.filter(n => n.beat < S.clipLen);
    S.sel = { ...S.sel, beat: r6(s + l) };
    refreshSel();
  }
  function deleteSpace(): void {
    if (!S.sel || S.sel.len <= 0) return;
    saveUndo();
    const s = S.sel.beat, l = S.sel.len, e = s + l;
    const out: N[] = [];
    for (const n of S.notes) {
      if (n.beat >= e - 1e-9) { n.beat = r6(n.beat - l); out.push(n); }
      else if (n.beat >= s - 1e-9) continue;
      else { if (n.beat + n.len > s) n.len = Math.max(MINLEN, r6(s - n.beat)); out.push(n); }
    }
    S.notes = out;
    resetSel();
  }
  function trimSel(): void {
    if (!S.sel || S.sel.len <= 0) return;
    const s = S.sel.beat, e = s + S.sel.len;
    saveUndo();
    const out: N[] = [];
    for (const n of S.notes) {
      if (!n.sel) { out.push(n); continue; }
      const b0 = Math.max(n.beat, s), b1 = Math.min(n.beat + n.len, e);
      if (b1 - b0 < 1e-6) continue;
      n.beat = r6(b0); n.len = Math.max(MINLEN, r6(b1 - b0)); out.push(n);
    }
    S.notes = out;
    refreshSel();
  }
  function selectAll(): void {
    if (!S.notes.length) return;
    S.notes.forEach(n => n.sel = true);
    S.sel = bound(S.notes); S.handles = true; invalidate();
  }

  /* ---------- Popup ---------- */
  function closePop(): void { pop.style.display = 'none'; }
  function showPop(x: number, y: number, items: Array<[string, () => void]>): void {
    pop.innerHTML = '';
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { closePop(); fn(); notify(); };
      pop.appendChild(b);
    }
    pop.style.display = 'flex';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(x / dpr - pw / 2, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(y / dpr - ph / 2, 4, H / dpr - ph - 4) + 'px';
  }
  function openMenu(p: Pt): void {
    showPop(p.x, p.y, [
      ['Deselect', resetSel],
      ['Insert space', insertSpace],
      ['Duplicate', duplicateSel],
      ['Delete', deleteSel],
      ['Delete space', deleteSpace],
      ['Trim selection', trimSel]
    ]);
  }

  /* ---------- Pointer / gesture ---------- */
  const ptrs = new Map<number, Gs>();
  let pinch: Pinch | null = null;
  const pt = (e: { clientX: number; clientY: number }): Pt => { const r = cv.getBoundingClientRect(); const k = cv.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
  const inArea = (x: number, y: number): boolean => x >= areaX && x < areaX + areaW && y >= areaY && y < areaY + areaH;

  function keyDown(gs: Gs, q: Pt): void {
    const key = 127 - clamp(Math.floor(yToRow(q.y)), 0, 127);
    gs.key = key; gs.vel = clamp(q.x / kbW, 0.05, 1);
    if (held.has(key)) held.get(key)!.stop();
    held.set(key, voice(key, gs.vel)); invalidate();
  }
  function keyMove(gs: Gs, q: Pt): void {
    const key = 127 - clamp(Math.floor(yToRow(q.y)), 0, 127);
    if (key === gs.key) return;
    releaseKey(gs.key!);
    gs.key = key; held.set(key, voice(key, gs.vel!)); invalidate();
  }
  function releaseKey(k: number): void {
    const v = held.get(k); if (v) { v.stop(); held.delete(k); }
    invalidate();
  }

  function velApply(gs: Gs, a: Pt, b: Pt): void {
    const x0 = Math.min(a.x, b.x) - 1, x1 = Math.max(a.x, b.x) + 1;
    const bottom = velY + velH;
    for (const n of S.notes) {
      const nx = bx(n.beat);
      if (nx + 6 * dpr < x0 || nx - 2 * dpr > x1) continue;
      const t = b.x === a.x ? 1 : clamp((nx + 2 - a.x) / (b.x - a.x), 0, 1);
      const y = a.y + (b.y - a.y) * t;
      const frac = clamp((bottom - y) / velH, 1 / 127, 1);
      const v = Math.round(frac * 255);
      if (v !== n.vel) { n.vel = v; gs.changed = true; S.lastVel = v / 255; }
    }
    invalidate();
  }

  function beginDrag(gs: Gs, type: DragType, q: Pt): void {
    saveUndo();
    const sn = selNotes();
    gs.mode = 'drag'; gs.type = type; gs.s0 = { ...S.sel! }; gs.start = q;
    gs.minBeat = Math.min(...sn.map(n => n.beat));
    gs.maxBeat = Math.max(...sn.map(n => n.beat));
    gs.minRow = Math.min(...sn.map(n => 127 - n.key));
    gs.maxRow = Math.max(...sn.map(n => 127 - n.key));
    drag = { type, dBeat: 0, dRow: 0, dLen: 0, scale: 1 };
    invalidate();
  }
  function dragMove(gs: Gs, q: Pt): void {
    const d = drag!;
    const pb = pxBeat(), rh = rowH(), s0 = gs.s0!;
    const dx = q.x - gs.start!.x, dy = q.y - gs.start!.y;
    if (gs.type === 'move') {
      let dB = r6(align(s0.beat + dx / pb) - s0.beat);
      dB = clamp(dB, -gs.minBeat!, S.clipLen - MINLEN - gs.maxBeat!);
      let dR = Math.round(dy / rh);
      dR = clamp(dR, -gs.minRow!, 127 - gs.maxRow!);
      if (dR !== d.dRow) {
        if (gs.pv != null) releaseKey(gs.pv);
        gs.pv = 127 - (s0.row + dR);
        held.set(gs.pv, voice(gs.pv, 0.7));
      }
      d.dBeat = dB; d.dRow = dR;
    } else {
      const end = align(s0.beat + s0.len + dx / pb);
      const newLen = Math.max(MINLEN, end - s0.beat);
      if (gs.type === 'resize') d.dLen = r6(newLen - s0.len);
      else d.scale = clamp(newLen / Math.max(s0.len, MINLEN), 0.2, 10);
    }
    invalidate();
  }
  function commitDrag(gs: Gs): void {
    const d = drag!; drag = null;
    if (gs.pv != null) { releaseKey(gs.pv); gs.pv = null; }
    const changed = d.dBeat || d.dRow || d.dLen || d.scale !== 1;
    if (!changed) { cancelUndo(); invalidate(); return; }
    const a = S.sel!.beat;
    for (const n of S.notes) {
      if (!n.sel) continue;
      if (d.type === 'move') { n.beat = r6(Math.max(0, n.beat + d.dBeat)); n.key -= d.dRow; }
      else if (d.type === 'resize') n.len = Math.max(MINLEN, r6(n.len + d.dLen));
      else { n.beat = r6(a + (n.beat - a) * d.scale); n.len = Math.max(MINLEN, r6(n.len * d.scale)); }
    }
    if (d.type === 'move') S.sel = { ...S.sel!, beat: r6(S.sel!.beat + d.dBeat), row: S.sel!.row + d.dRow };
    else if (d.type === 'resize') { S.sel = { ...S.sel!, len: Math.max(MINLEN, r6(S.sel!.len + d.dLen)) }; S.lastLen = selNotes()[0].len; }
    else { S.sel = { ...S.sel!, len: Math.max(MINLEN, r6(S.sel!.len * d.scale)) }; S.lastLen = selNotes()[0].len; }
    invalidate();
  }

  function beginSelect(gs: Gs): void {
    gs.mode = 'select';
    const b = clamp(align(xToBeat(gs.sx)), 0, S.clipLen);
    const r = clamp(Math.floor(yToRow(gs.sy)), 0, 127);
    gs.b0 = b; gs.r0 = r;
    selDrag = { b0: b, r0: r, b1: b, r1: r };
    S.notes.forEach(n => n.sel = false); S.sel = null; S.handles = false;
    invalidate();
  }
  function finishSelect(gs: Gs, q: Pt): void {
    const moved = Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr;
    const sd = selDrag; selDrag = null;
    if (!moved || !sd) {
      resetSel();
      if (clipboard.length) {
        const beat = align(xToBeat(q.x), 'floor');
        showPop(q.x, q.y - cell, [['Paste', () => pasteAt(clamp(beat, 0, S.clipLen))]]);
      }
      return;
    }
    const b0 = Math.min(sd.b0, sd.b1), b1 = Math.max(sd.b0, sd.b1);
    const r0 = Math.min(sd.r0, sd.r1), r1 = Math.max(sd.r0, sd.r1);
    let any = false;
    for (const n of S.notes) {
      const row = 127 - n.key;
      const inT = (b1 - b0 < 1e-6) ? (n.beat <= b0 && n.beat + n.len > b0) : (n.beat < b1 && n.beat + n.len > b0);
      n.sel = inT && row >= r0 && row <= r1;
      if (n.sel) any = true;
    }
    if (!any) { resetSel(); return; }
    S.sel = { beat: b0, row: r0, len: b1 - b0, rows: r1 - r0 + 1 };
    S.handles = true; invalidate();
  }

  function handleTap(q: Pt): void {
    const beat = xToBeat(q.x), row = Math.floor(yToRow(q.y));
    if (row < 0 || row > 127 || beat < 0 || beat >= S.clipLen) { if (S.sel) resetSel(); return; }
    const hit = hitNote(q.x, q.y);
    if (hit) { selectOnly(hit); return; }
    if (S.sel && S.handles) { resetSel(); return; }
    createNote(beat, row);
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
    if (pinch!.dx0 >= 30 * dpr) S.zH = clamp(pinch!.zH0 * dx / pinch!.dx0, ZHMIN, ZHMAX);
    if (pinch!.dy0 >= 30 * dpr) S.zV = clamp(pinch!.zV0 * dy / pinch!.dy0, ZVMIN, ZVMAX);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.posH = pinch!.mb - (mx - areaX) / pxBeat();
    S.posV = pinch!.mr - (my - areaY) / rowH();
    clampView(); syncZoomUI(); invalidate();
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

    if (q.x < kbW && q.y < rulerH) { gs.mode = 'corner'; togglePlay(); return; }
    if (q.y < rulerH) { gs.mode = 'ruler'; seekTo(q.x); return; }
    if (q.x < kbW && q.y < areaY + areaH) { gs.mode = 'key'; keyDown(gs, q); return; }
    if (velOn && q.y >= velY && q.x >= areaX) {
      gs.mode = 'vel'; saveUndo(); gs.changed = false; gs.last = q; velApply(gs, q, q); return;
    }
    if (!inArea(q.x, q.y)) { gs.mode = 'dead'; return; }
    if (S.sel && S.handles) {
      const hp = handlePos();
      for (const k of ['menu', 'move', 'resize', 'stretch'] as HandleKind[]) {
        const p = hp[k];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= cell * 0.6) {
          if (k === 'menu') { gs.mode = 'dead'; openMenu(p); } else beginDrag(gs, k, q);
          return;
        }
      }
    }
    const hit = hitNote(q.x, q.y);
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
      case 'ruler': seekTo(q.x); break;
      case 'key': keyMove(gs, q); break;
      case 'vel': velApply(gs, gs.last!, q); gs.last = q; break;
      case 'drag': dragMove(gs, q); break;
      case 'select':
        selDrag!.b1 = clamp(align(xToBeat(q.x)), 0, S.clipLen);
        selDrag!.r1 = clamp(Math.floor(yToRow(q.y)), 0, 127);
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
        clampView(); syncZoomUI(); invalidate(); break;
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
      case 'key': releaseKey(gs.key!); break;
      case 'vel':
        if (!gs.changed) cancelUndo();
        break;
      case 'drag': commitDrag(gs); break;
      case 'pinch':
        pinch = null;
        for (const o of ptrs.values()) if (o.mode === 'pinch') o.mode = 'dead';
        break;
    }
    invalidate();
    notify();
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
    clampView(); syncZoomUI(); invalidate();
  }
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const q = pt(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.altKey ? 'v' : 'h', f, q.x, q.y);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      S.posH += (e.deltaX || e.deltaY) * dpr / pxBeat(); clampView(); invalidate();
    } else {
      S.posV += e.deltaY * dpr / rowH(); clampView(); invalidate();
    }
  }, { passive: false });
  zhEl.addEventListener('input', () => {
    const b = xToBeat(areaX + areaW / 2);
    S.zH = fromPos(+zhEl.value, ZHMIN, ZHMAX);
    S.posH = b - (areaW / 2) / pxBeat(); clampView(); invalidate();
  });
  zvEl.addEventListener('input', () => {
    const r = yToRow(areaY + areaH / 2);
    S.zV = fromPos(+zvEl.value, ZVMIN, ZVMAX);
    S.posV = r - (areaH / 2) / rowH(); clampView(); invalidate();
  });

  /* ---------- Toolbar & keyboard ---------- */
  function setTheme(name: 'light' | 'dark'): void {
    C = THEMES[name];
    for (const k in C.css) root.style.setProperty(k, C.css[k]);
    themeEl.value = name;
    invalidate();
  }
  function setColor(c: string): void {
    S.color = c;
    root.style.setProperty('--note', c);
    if ([...colorEl.options].some(o => o.value === c)) colorEl.value = c;
    invalidate();
  }
  themeEl.addEventListener('change', () => setTheme(themeEl.value as 'light' | 'dark'));
  bPlay.onclick = togglePlay;
  bpmEl.addEventListener('input', () => {
    S.bpm = clamp(+bpmEl.value || 120, 40, 240);
    if (playing) { const a = absNow(); playStartAbs = a; playT0 = ac!.currentTime; schedAbs = a; }
  });
  colorEl.addEventListener('change', () => setColor(colorEl.value));
  uiEl.addEventListener('change', () => { uiScale = +uiEl.value; layout(); });
  snapSel.addEventListener('change', invalidate);
  bVel.onclick = () => { velOn = !velOn; bVel.classList.toggle('on', velOn); layout(); };
  bUndo.onclick = () => { undo(); notify(); };
  bRedo.onclick = () => { redo(); notify(); };
  bClear.onclick = () => { if (!S.notes.length) return; saveUndo(); S.notes = []; resetSel(); notify(); };

  const onKey = (e: KeyboardEvent): void => {
    const t = (e.target as HTMLElement | null)?.tagName;
    if (t === 'INPUT' || t === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'escape') { resetSel(); closePop(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
    else if (mod && k === 'c') { e.preventDefault(); copySel(); }
    else if (mod && k === 'v') { e.preventDefault(); pasteAt(clamp(align(S.posH, 'ceil'), 0, S.clipLen)); }
    notify();
  };
  window.addEventListener('keydown', onKey);

  /* ---------- Loop render ---------- */
  let lastT = 0, raf = 0, dead = false;
  function frame(t: number): void {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, t - lastT); lastT = t;
    if (inertia) {
      S.posH -= inertia.vx * dt / pxBeat();
      S.posV -= inertia.vy * dt / rowH();
      const f = Math.pow(0.95, dt / 16.7);
      inertia.vx *= f; inertia.vy *= f;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.02) inertia = null;
      clampView(); syncZoomUI(); dirty = true;
    }
    if (dirty || playing) { dirty = false; draw(); }
  }

  /* ---------- Posisi awal saat dibuka ---------- */
  // Ada note: scroll ke baris nada tertinggi + 2 dan ke beat note pertama. Kosong: ke MIDI 70 di beat 0. Zoom dikembalikan ke bawaan.
  function setInitialView(): void {
    S.zH = 4; S.zV = 0.75;
    if (S.notes.length) {
      const hi = Math.max(...S.notes.map(n => n.key));
      S.posV = 127 - Math.min(127, hi + 2);
      S.posH = Math.min(...S.notes.map(n => n.beat));
    } else { S.posV = 127 - 70; S.posH = 0; }
    clampView(); syncZoomUI(); invalidate();
  }

  /* ---------- Init ---------- */
  S.notes = (opts.notes ?? []).map(toN);
  lastSnap = JSON.stringify(S.notes.map(n => [n.key, n.beat, n.len, n.vel]));
  setInitialView();
  bpmEl.value = String(S.bpm);
  setTheme(opts.theme ?? 'light');
  setColor(S.color);
  syncZoomUI(); updUndo();
  resize();
  raf = requestAnimationFrame(frame);

  /* ---------- Handle ---------- */
  return {
    destroy(): void {
      dead = true;
      cancelAnimationFrame(raf);
      stopPlay();
      held.forEach(v => v.stop()); held.clear();
      flashTimers.forEach(id => clearTimeout(id)); flashTimers.clear();
      for (const g of ptrs.values()) clearTimeout(g.timer);
      ptrs.clear();
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      if (ac) { void ac.close(); ac = null; master = null; }
      root.remove();
    },
    getNotes(): PRNote[] { return S.notes.map(n => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel })); },
    setNotes(notes: PRNote[]): void {
      S.notes = notes.map(toN);
      lastSnap = JSON.stringify(S.notes.map(n => [n.key, n.beat, n.len, n.vel]));
      undoS.length = 0; redoS.length = 0; updUndo();
      resetSel(); setInitialView();
    },
    resize,
    setClipOffset(beats: number): void { S.clipOffset = beats; invalidate(); },
    setClipLen(beats: number): void { S.clipLen = Math.max(1, beats); if (playhead > S.clipLen) playhead = 0; clampView(); invalidate(); },
    setColor(c: string): void { setColor(c); },
    stop(): void { stopPlay(); }
  };
}
