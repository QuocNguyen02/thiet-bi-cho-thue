/* Web app trên iPhone: lưu sẵn giao diện để mở được khi mạng chập chờn.
   - Chỉ xử lý file của chính trang web (cùng địa chỉ). Dữ liệu Google Sheet đi thẳng tới Google, không lưu ở đây.
   - Có mạng: luôn lấy bản mới nhất (cập nhật web là các máy có ngay); mất mạng: dùng bản đã lưu.
   - Chỉ lưu đúng các file của app (mở trang với ?… vẫn dùng chung một bản index.html). */
const CACHE = 'tbct-web-v2';
const FILES = ['index.html', 'app.js', 'styles.css', 'guide.html', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const BASE = new URL('./', self.location).pathname;          // thư mục chứa app (VD /thietbi/)
const keyFor = (req) => {
  const url = new URL(req.url);
  if (req.mode === 'navigate') return 'index.html';
  const rel = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : null;
  return rel !== null && FILES.includes(rel) ? rel : null;   // file lạ: không lưu
};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const key = keyFor(req);
  if (!key) return;                                          // để trình duyệt tự xử lý
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.open(CACHE).then((c) => c.match(key)).then((hit) => hit || Response.error())),
  );
});
