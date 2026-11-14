// tree2 Service Worker：可安装 + 离线浏览目录（文件字节仍需联网）
// 清单/页面网络优先（发布后学生立刻看到新版），静态资源缓存优先（秒开）
const CACHE = 'tree2-pwa-v5';
const SHELL = ['/', '/index.html', '/css/tree2.css', '/js/app.js', '/js/api.js', '/js/preview.js', '/assets/paw.svg', '/assets/facivon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 管理 API（含 /stats 统计——缓存它会让 admin.html 显示昨天的数据）、
  // 管理页 admin.html（历史名 up.html 也拦）、sw 自身：一律网络直连。
  // 部署后这些页面绝不能"卡回去"。
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin.html' || url.pathname === '/customer.html' || url.pathname === '/up.html' || url.pathname === '/sw.js') return;

  const isData = url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.json') || url.pathname.startsWith('/api/tree2/seasons') || url.pathname.startsWith('/api/tree2/storage');
  if (isData) {
    // 网络优先：发布后学生立刻看到新版；断网回缓存（离线可浏览目录）
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req)),
    );
  } else {
    // 静态资源缓存优先
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })),
    );
  }
});
