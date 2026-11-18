# treenext

tree2 内容站 + 内容寻址文件库（files.example.com）。服务入口为 `scripts/tree2-files-server.mjs`，静态页面位于 `public/tree2/`。

## 目录职责

| 服务器路径 | 归属 | 部署行为 |
|---|---|---|
| `scripts/tree2-*.mjs` | 仓库 | rsync 覆盖 + `systemctl restart tree2` |
| `scripts/tree2-ingest-push.mjs` | 仓库 | 入库推送模块（队列/发送/重试），见「入库订阅 → 代码位置」 |
| `public/tree2/`（除 data/ 与根目录 2026/2027.json） | 仓库 | rsync 覆盖 |
| `public/tree2/music-custom.js` / `music-custom.css` | 仓库（给 Navidrome 用，不是 tree2 页面的资源） | rsync 覆盖；由 Navidrome 的 customhead/theme 引用本站的这两个地址，实现 ±15s/倍速/黑胶播放页外观。改完这两个文件要同步 Navidrome 侧的引用（文件名没变则不用） |
| `public/tree2/data/`（2026/2027/seasons.json） | 服务器（运行时清单，上传/删除/重扫都会改写） | `.deployignore` 保护 |
| `/srv/treenext/data/` | 服务器（上传日志、分享映射、下载统计、顾客口令、Navidrome 配置） | `.deployignore` 保护。音频预览优先走 `navidrome.json` 的 `internal`（如 `http://127.0.0.1:4533`），未配置或未同步时从本地对象读取 |
| `/srv/treenext/storage/` | 服务器（内容寻址对象库 objects/） | `.deployignore` 保护 |
| `/srv/treenext/preview-cache/`、`backups/` | 服务器 | `.deployignore` 保护 |

## 部署

GitHub Actions（`.github/workflows/deploy.yml`，参考 landing-page 模式）：

- `push` 到 main 或手动 `workflow_dispatch` 触发
- secrets：`SERVER_SSH_KEY`、`SERVER_KNOWN_HOSTS`、`SERVER_HOST`、`SERVER_PORT`、`SERVER_USER`、`DEPLOY_PATH`
- rsync `--delete --exclude-from=.deployignore` 同步到 `/srv/treenext/`，然后 `systemctl restart tree2`
- 启动时为现有目录分配稳定的 `folderId`，并将旧顾客口令迁移到批次根目录的 ID。唯一匹配的授权会保留原链接、有效期和已用次数。未能唯一匹配的批次需要管理员核对后重发。

## 删除语义（2026-11 修复后）

`POST /api/tree2/remove` 从清单移除条目后，会检查所有届的清单及
audio-map / share-map / shares 是否仍引用该内容（按 sha256）；
零引用则连 `objects/` 里的文件本体一起删除，并在响应里返回
`deletedObjects`。仍被引用的对象保留（内容寻址去重，可能被别的
条目/分享使用）。

## WebDAV

`scripts/tree2-webdav.mjs` 把「哈希对象库 + 清单 JSON」实时翻译成中文名目录树，挂载在 `/webdav`：

```text
/webdav/                       → 届别列表（2027届 / 2026届 …）
/webdav/2027/                  → 该届所有批次
/webdav/2027/<批次>/            → 批次内目录与文件
/webdav/2027/<批次>/<子目录>/…   → 递归
```

支持 `PROPFIND`（列出）、`GET`/`HEAD`（含 Range）、`PUT`（写对象库 + 改清单 + 记 uplog）、`MKCOL`、`MOVE`、`DELETE`（摘出清单后按引用回收对象）、`LOCK`/`UNLOCK`（返回合法 token，不真正互斥）、`PROPPATCH`（回成功不存属性）。

鉴权复用主服务的 `TREE2_TOKEN`：`Basic` 时用户名任意、密码填 token；也接受 `Bearer`。`OPTIONS` 排在鉴权之前放行，否则 Windows「添加网络位置」拿不到 `DAV: 1,2` 会判定文件夹无效。

写操作必须落在批次内（`/webdav/<届>/<批次>/…`）；届与批次本身不能通过 WebDAV 删除或移动，请用 Console。nginx 侧把 `/webdav` 反向代理到 `127.0.0.1:8787`，并关闭 `proxy_buffering` / `proxy_request_buffering`，否则大文件上传会整份堆内存。

## 目录整理与离线重扫

`POST /api/tree2/arrange` 使用同一组参数预览及执行。请求带 `year`、`action`、`source` 路径数组，以及操作所需的 `name` 或 `kind`、`destination`。预览返回 `revision`、移动文件数和冲突摘要。执行时带回 `revision`，服务会在写入前重新校验。

`move` 支持跨批次：`destination[0]` 填其他批次名即可把文件或整个文件夹搬到该批次。目标批次必须已存在（不会自动新建），批次内缺失的末级目录会自动创建（与上传补目录一致）；跨批次预览会带 `crossBatch: true`，自动创建目录时带 `foldersCreated: 1`。批次统计（files/bytes）随内容走，写盘前统一重算。文件夹跨批次移动保留目录身份（folderId），旧分享链接继续打开原目录。

`source` 只有一段批次名且 `kind: 'd'` 时是**整批并入**：把该批次的全部顶层条目搬进 `destination`，然后移除原批次。目标必须是另一批次内的具体目录（不能是批次根目录，不能是自身），目录不存在会自动创建；任一条目与目标同名则整体拒绝。空批次会被拒绝。这个操作不可逆，Console 会在确认弹窗里写明原批次将被移除。

成功操作写进 `uplog.json`，事件类型为 `arrange`，保留 `season`、`action` 和原始路径参数。离线重扫工具需要按日志顺序把同样的目录操作应用到本地源树，再重新生成清单。发布前请验证重扫后仍保留这些改动；本仓库的部署工作流会保护当前运行时清单。

顾客口令绑定批次 ID。批次改名后原口令继续可用，删除后同名新批次有自己的 ID。新目录分享用 `/d/id/<届别>/<folderId>`。旧路径在改名或移动后会跳转到原目录，路径复用也保留原链接的指向。删除、解散、压平移除的目录会显示说明和仍可打开的上级目录。

离线工具重放线上目录变更后，发布前运行下面的命令，让重扫结果继承线上清单的目录身份、旧链接映射和移除记录。输入使用同一届的最新线上清单与重扫结果。输出是新的文件。

```text
node scripts/tree2-preserve-folder-ids.mjs online-2026.json scanned-2026.json ready-2026.json
```

如果离线整理中删除并同名重建了批次或目录，重复使用 `--new "批次名/子目录名"` 标记对应路径，批次根目录直接使用批次名。标记的目录及其子目录会获得新 ID。发布前核对线上快照仍是最新版本，避免把重扫期间的新变更覆盖掉。

## 入库订阅

在 TreeNext 服务配置 `TREE2_UPDATE_ORIGIN`（业务 Backend 的 HTTPS 源站）和
`TREE2_UPDATE_TOKEN`。在 Backend 设置相同的独立令牌，先应用
`031-resource-push-digests` 迁移并更新 Bot，再在 Console「Bot → 订阅推送 → TreeNext」配置目标群。
默认关闭推送，默认上传来源是管理上传。需要时可单独选择顾客口令上传。

通过 GitHub Actions 发布时，把 `TREE2_UPDATE_TOKEN` 配在仓库的 `production` Environment。
工作流会将令牌和生产地址写入受保护的 `data/update-push.json`。进程环境中的配置优先。

入库事件通过运行时 `data/update-outbox/` 重试发往 Backend。启用合图时，同群从最近一次入库等待约两分钟，从第一条最多等待约五分钟。群消息附稳定的批次目录链接。离线重扫通过自己的发布工具写清单，目前未接入此事件。

### 代码位置

推送逻辑单独放在 `scripts/tree2-ingest-push.mjs`，`tree2-files-server.mjs` 只注入依赖、启轮询，不参与队列和发送细节：

| 文件 | 职责 |
|---|---|
| `scripts/tree2-ingest-push.mjs` | 读配置、校验源站、事件入队、投递重试。不认识 manifest 结构 |
| `scripts/tree2-files-server.mjs` | 入库成功时调 `enqueue()`；启动时调 `start()`；提供 `writeLibrary` / `readManifest` 两个能力 |

模块导出：

```js
import { createIngestPush, readUpdateCredentials, resolveUpdateEndpoint, updateLabel } from './tree2-ingest-push.mjs';

const credentials = await readUpdateCredentials(SHARES_DIR);        // 环境变量优先，其次 data/update-push.json
const endpoint = resolveUpdateEndpoint(cfg, credentials);           // 不满足条件返回 null（=不推送）
const push = createIngestPush({ sharesDir, endpoint, token, writeLibrary, readManifest });

await push.enqueue({ year, batchId, batch, name, origin, key, folder });  // 入库成功时
push.cancel(file);                                                        // 入库事务失败时撤回
push.start();                                                             // 服务启动时，返回停止函数
```

### 行为约定

- **只推新增或内容变更**：入库时 `changed`（`existing.k !== key`）才入队，重传同一个文件不会重复推。
- **先落盘再发送**：事件写成 `update-outbox/<毫秒>-<uuid>.json`，服务重启不丢。
- **202 才算成功**：Backend 返回非 202 就当失败，事件保留，每 5 秒重试；成功才删文件。
- **发送前回查**：重启可能留下「事件已暂存、但 manifest 尚未替换」的残局，投递前确认文件真在 manifest 里，否则直接丢弃，避免误报。
- **只处理 20xx 年目录**：`/^20\d{2}$/`，其他目录不入队。
- **源站必须是纯 HTTPS**：带路径、查询串、账号密码的一律拒绝。
- **标签清洗**：批次名/文件名截断并去掉控制字符与双向文本控制符，防止注入群消息。
- **未配置时全部空转**：`endpoint` 为 null 时 `enqueue()` / `flush()` 都不做事，不影响上传本身。

## 本地开发

```text
npm run dev
```

使用 Node.js 24，无需安装依赖。打开 [本地示例](http://127.0.0.1:8787/tree2/index.html?api=reset)，进入示例文件夹查看预览。也可以打开 [本地管理页](http://127.0.0.1:8787/tree2/admin.html)，用口令 `tree2-local-preview` 测试上传。示例清单及上传文件保存在 `storage/local-preview/`，与生产数据隔离。本地示例音频使用与线上相同的 Navidrome 分享页：播放器页面和静态资源是线上原样副本，分享信息按本地清单生成。

如果这份预览已在运行，再执行启动命令会显示现有地址。如果默认端口被其他程序使用，在命令提示符执行 `set "PORT=8788" && npm run dev`，或在 PowerShell 执行 `$env:PORT = '8788'; npm run dev`，再打开终端显示的网址。

本地预览默认只用本地数据；在 `127.0.0.1` 上即使浏览器以前记住了线上 API，也会自动回到同源。需要临时查看线上数据时，手动在地址后加 `?api=https://files.example.com`；打开 `?api=reset` 即可切回。管理上传页始终使用本地服务。

直接启动 `node scripts/tree2-files-server.mjs` 时，服务使用通常的 `public/tree2/data/` 和 `storage/tree2/`，干净仓库里的届别列表为空。
