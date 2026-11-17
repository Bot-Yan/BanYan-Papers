# PDF 解密服务

官网的文件预处理页向 `https://files.example.com/api/pdf/unlock` 发送受保护的 PDF 字节。TreeNext Nginx 将请求转给 `127.0.0.1:8791` 上的独立 Flask 服务。服务通过 pikepdf 调用 qpdf，在内存中重写文件并返回。需要打开密码的文件返回 422。普通 PDF 按原样返回。服务无数据库依赖。

服务由 `pdf-unlock.service` 管理，现有入口位于 `/opt/pdf-unlock-server/unlock_server.py`。更新时将本目录里的 `unlock_server.py` 发布到该位置，然后重启 `pdf-unlock.service`，检查 `/api/pdf/health`。正常的 TreeNext 发布只重启资料库主服务。

初次安装需要 Python 虚拟环境、Flask 3.1 与 pikepdf，Nginx 反代可参考 `patch_nginx.py`。在服务环境中用 `ALLOW_ORIGIN` 配置官网来源，多个来源以半角逗号分隔。服务默认监听本机 8791，请求体默认上限 80 MiB。

本地测试使用生成的 PDF 样例。安装 Flask 和 pikepdf 后运行 `python -m unittest discover -s ops/pdf-unlock`。
