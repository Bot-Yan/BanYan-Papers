"""TreeNext 的 PDF 解密接口，通过 pikepdf/qpdf 在内存中重写可用空密码打开的 PDF。"""
import io
import os

from flask import Flask, Response, jsonify, request

try:
    import pikepdf
except ImportError:  # pragma: no cover
    raise SystemExit("需要 pikepdf：pip install pikepdf")

app = Flask(__name__)

# 允许的页面来源，逗号分隔。页面部署在 www.example.com，接口在 files.example.com，
# 属于跨域，所以必须明确放行这几个域。
ALLOW_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALLOW_ORIGIN",
        "https://www.example.com,https://example.com,http://localhost:4321",
    ).split(",")
    if o.strip()
]
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(80 * 1024 * 1024)))
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify(error="文件太大（上限 %d MB）" % (MAX_BYTES // 1024 // 1024)), 413


def cors_origin():
    """按请求的 Origin 回显——只回白名单里的，不顺带放行任意站点。"""
    origin = request.headers.get("Origin", "")
    if origin in ALLOW_ORIGINS or "*" in ALLOW_ORIGINS:
        return origin if "*" not in ALLOW_ORIGINS else "*"
    return None


@app.after_request
def add_cors(resp):
    origin = cors_origin()
    resp.vary.add("Origin")
    resp.headers["Cache-Control"] = "no-store"
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "86400"
        resp.headers["Access-Control-Expose-Headers"] = "X-Unlock-Encrypted, X-Unlock-Pages"
    return resp


@app.route("/api/pdf/unlock", methods=["OPTIONS"])
def unlock_preflight():
    return ("", 204)


@app.route("/api/pdf/unlock", methods=["POST"], provide_automatic_options=False)
def unlock():
    data = request.get_data(cache=False)
    if not data:
        return jsonify(error="请求体是空的"), 400
    if len(data) > MAX_BYTES:
        return file_too_large(None)
    if not data.startswith(b"%PDF"):
        return jsonify(error="这不是 PDF 文件"), 400

    # 内存里解，不写临时文件；pikepdf 需要可 seek 的对象，用 BytesIO 就够了
    try:
        with pikepdf.open(io.BytesIO(data), password="") as pdf:
            was_encrypted = pdf.is_encrypted
            buf = io.BytesIO()
            if was_encrypted:
                pdf.save(buf, encryption=False)
            pages = len(pdf.pages)
    except pikepdf.PasswordError:
        return jsonify(error="这份 PDF 设了打开密码，需要先输入密码才能解密", reason="needs-password"), 422
    except pikepdf.PdfError:
        return jsonify(error="PDF 解析失败，请检查文件是否损坏"), 400

    resp = Response(buf.getvalue() if was_encrypted else data, mimetype="application/pdf")
    resp.headers["X-Unlock-Encrypted"] = "1" if was_encrypted else "0"
    resp.headers["X-Unlock-Pages"] = str(pages)
    return resp


@app.route("/api/pdf/health", methods=["GET"])
def health():
    return jsonify(ok=True, engine="qpdf via pikepdf", version=pikepdf.__version__)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8791"))
    print("qpdf 引擎版本:", pikepdf.__version__)
    print("允许来源:", ", ".join(ALLOW_ORIGINS))
    app.run(host=host, port=port, threaded=True)
