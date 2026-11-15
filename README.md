# treenext

tree2 内容站 + 内容寻址文件库（files.example.com）。代码 = 单文件 Node 服务 `scripts/tree2-files-server.mjs` + `public/tree2/` 静态站点。

## 目录职责

| 服务器路径 | 归属 | 部署行为 |
|---|---|---|
| `scripts/tree2-files-server.mjs` | 仓库 | rsync 覆盖 + `systemctl restart tree2` |
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
- 启动时为旧顾客口令补齐届别。唯一匹配的批次会自动绑定，现有链接、有效期和已用次数继续生效。跨届同名或找不到的批次会从该口令的授权范围移除，需要管理员按正确届别重发。

## 删除语义（2026-11 修复后）

`POST /api/tree2/remove` 从清单移除条目后，会检查所有届的清单及
audio-map / share-map / shares 是否仍引用该内容（按 sha256）；
零引用则连 `objects/` 里的文件本体一起删除，并在响应里返回
`deletedObjects`。仍被引用的对象保留（内容寻址去重，可能被别的
条目/分享使用）。

## 目录整理与离线重扫

`POST /api/tree2/arrange` 使用同一组参数预览及执行。请求带 `year`、`action`、`source` 路径数组，以及操作所需的 `name` 或 `kind`、`destination`。预览返回 `revision`、移动文件数和冲突摘要。执行时带回 `revision`，服务会在写入前重新校验。

成功操作写进 `uplog.json`，事件类型为 `arrange`，保留 `season`、`action` 和原始路径参数。离线重扫工具需要按日志顺序把同样的目录操作应用到本地源树，再重新生成清单。发布前请验证重扫后仍保留这些改动；本仓库的部署工作流会保护当前运行时清单。

## 本地开发

```bash
node scripts/tree2-files-server.mjs --port 8787 --root . --allow-origin http://localhost:4321
```

清单、对象库等运行数据只在服务器上，本地没有；需要数据时从服务器备份 `backups/tree2-meta-*.tar.gz` 取。
