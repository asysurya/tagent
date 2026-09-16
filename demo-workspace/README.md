# Demo Workspace

Proyek mini buat nyoba Tagent: **TaskFlow** — aplikasi to-do berbasis vanilla JS.

## Cara jalan
Buka `index.html` di browser.

## Ada bug yang dikenal (buat demo)
`app.js` → `renderTasks()`:
- Counter "N tasks left" di header tidak pernah diperbarui setelah menambah/menghapus task.
- Tombol "Clear completed" tidak berfungsi.

Coba minta agent: *"perbaiki bug counter dan tombol Clear completed"* — lalu lihat
diff di panel Files, dan undo via checkpoint kalau mau balikin.
