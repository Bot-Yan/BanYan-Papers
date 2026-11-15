import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const localTrack = /^local-([a-f0-9]{64})(\.[a-z0-9]{1,8})$/;
const assets = /^\/music\/share\/(?:assets\/[\w.-]+\.(?:js|css|woff2)|[\w-]+\.(?:png|svg|webmanifest))$/;
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

export function localPlayerId(key) {
  return `local-${key.slice(3)}`;
}

/**
 * 本地示例音频使用与线上相同的 Navidrome 分享页。
 * directory 是线上分享页及静态资源的原样副本；分享信息按本地清单实时生成。
 */
export async function createLocalPlayer(directory, findFile) {
  // 模板按请求现读：改 share-template.html（比如调 ?v= 缓存版本号）不用重启服务。
  // 只有播放器配置是启动时读一次。
  const config = await readFile(join(directory, 'player-config.json'), 'utf8').then(JSON.parse);
  const scriptString = value => JSON.stringify(JSON.stringify(value)).replaceAll('<', '\\u003c');
  return async function serveLocalPlayer(req, res, url) {
    const pathname = url.pathname;
    const send = (body, type) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    };
    if (assets.test(pathname)) {
      return send(await readFile(join(directory, pathname.slice(1))), mime[extname(pathname)]);
    }
    const match = /^\/music\/share\/(?:(s|img)\/)?([^/]+)$/.exec(pathname);
    const track = match && localTrack.exec(match[2]);
    if (!track) return false;
    const [id, hash, ext] = track;
    const key = `${hash.slice(0, 2)}/${hash}${ext}`;
    const file = await findFile(key);
    if (!file) return false;
    if (match[1] === 'img') return send(await readFile(join(directory, 'cover')), 'image/png');
    if (match[1] === 's') {
      const query = new URLSearchParams({ k: key, n: file.name });
      res.writeHead(307, { Location: `/api/tree2/files/${encodeURIComponent(file.season)}?${query}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const template = await readFile(join(directory, 'share-template.html'), 'utf8');
    const title = file.name.slice(0, -ext.length);
    const page = template.replace('__LOCAL_APP_CONFIG__', () => scriptString({
      ...config, baseURL: '/music', shareURL: '', auth: { isAdmin: false },
    })).replace('__LOCAL_SHARE_INFO__', () => scriptString({
      id, description: title, downloadable: false,
      tracks: [{ id, title, artist: '本地预览', album: '本地示例', updatedAt: '', duration: 0 }],
    }));
    return send(page, 'text/html; charset=utf-8');
  };
}
