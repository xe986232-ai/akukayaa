# DAW Starter

Playlist + piano roll berbasis canvas (Vite + TypeScript, tanpa framework).

- `npm install` lalu `npm run dev` untuk jalan lokal.
- `npm run build` menghasilkan folder `dist/`.
- Deploy ke Vercel: import repo/folder ini, preset **Vite** terdeteksi otomatis (build `npm run build`, output `dist`).

Alur: double-tap clip di playlist membuka piano roll di bawah; perubahan note langsung tersimpan ke clip.
Project tersimpan otomatis di localStorage browser; tombol Ekspor/Impor memakai file JSON.
