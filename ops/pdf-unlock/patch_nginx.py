#!/usr/bin/env python3
"""为 TreeNext 的 Nginx 加入 /api/pdf/ 反代段。可重复执行。"""
import datetime
import shutil
import sys

CONF = "/etc/nginx/sites-available/treenext.conf"
ANCHOR_CANDIDATES = [
    "# 文件夹分享页（/d/",
    "location /d/ {",
]

BLOCK = """    # PDF 解密服务（/opt/pdf-unlock-server，python+flask 监听 127.0.0.1:8791，引擎 qpdf）
    location /api/pdf/ {
        proxy_pass http://127.0.0.1:8791;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 100m;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

"""


def main():
    with open(CONF, encoding="utf-8") as fh:
        text = fh.read()

    if "/api/pdf/" in text:
        print("SKIP: /api/pdf/ 已存在")
        return 0

    anchor = None
    for cand in ANCHOR_CANDIDATES:
        idx = text.find(cand)
        if idx != -1:
            # 回退到该行行首
            line_start = text.rfind("\n", 0, idx) + 1
            anchor = line_start
            break

    if anchor is None:
        print("ERROR: 找不到插入点")
        return 1

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = CONF + ".bak-" + stamp
    shutil.copy2(CONF, backup)
    print("备份:", backup)

    new_text = text[:anchor] + BLOCK + text[anchor:]
    # 写临时文件再替换，避免写到一半
    tmp = CONF + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(new_text)
    shutil.move(tmp, CONF)
    print("已插入 /api/pdf/ 段")
    return 0


if __name__ == "__main__":
    sys.exit(main())
