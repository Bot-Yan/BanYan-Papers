// tree2 Service Worker：可安装 + 离线浏览目录（文件字节仍需联网）
// 清单/页面网络优先（发布后学生立刻看到新版），静态资源缓存优先（秒开）
const CACHE = 'tree2-pwa-v10';
// js/css 不进 SHELL：页面引用它们时都带 ?v= 版本参数（js/app.js?v=…），预缓存的
// 无版本路径是不同的缓存键，永远命中不了，等于白白多下载一份。版本化资源的
// 更新靠改 ?v=（缓存优先策略下新请求键不同，自然拿到新文件）。
const SHELL = ['/', '/index.html', '/assets/paw.svg', '/assets/facivon.svg'];

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
  const publicCatalogue = !url.search && /^\/api\/tree2\/(?:seasons(?:\/\d{4})?|storage\/\d{4})$/.test(url.pathname);
  if (req.headers.has('Authorization') || req.headers.has('X-Tree2-Token') ||
      (url.pathname.startsWith('/api/') && !publicCatalogue) ||
      url.pathname.startsWith('/d/') || url.pathname.startsWith('/s/') || url.pathname.startsWith('/music/share/') ||
      ['/admin.html', '/customer.html', '/up.html', '/sw.js'].includes(url.pathname)) return;
  // Navidrome 的注入地址由服务器配置，因此发布时版本参数未必随仓库更新。
  if (url.pathname === '/music-custom.js' || url.pathname === '/music-custom.css') {
    e.respondWith(fetch(req, { cache: 'no-cache' }));
    return;
  }

  const isData = publicCatalogue || url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.json');
  if (isData) {
    // 网络优先：发布后学生立刻看到新版；断网回缓存（离线可浏览目录）
    e.respondWith(
      fetch(req)
        .then((r) => {
          const restricted = /\b(?:no-store|private)\b/i.test(r.headers.get('Cache-Control') || '');
          if (publicCatalogue && (restricted || (!r.ok && r.status < 500))) {
            e.waitUntil(caches.open(CACHE).then(c => c.delete(req)).catch(() => {}));
          }
          if (r.ok && !restricted) {
            const copy = r.clone();
            e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}));
          }
          return r;
        })
        .catch(async () => await caches.match(req) || Response.error()),
    );
  } else {
    // 静态资源缓存优先
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })),
    );
  }
});
