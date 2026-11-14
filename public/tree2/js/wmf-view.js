// ---------------------------------------------------------------- WMF 公式渲染（MathType OLE 预览图 → canvas）
// 浏览器里 docx 的 MathType 公式是 WMF（v:imagedata），docx-preview 渲染不了。
// 这里内置一个宽容的 MS-WMF 解释器：只实现 MathType 实际写出的记录子集，
// 未知记录按 Size 跳过、绝不抛错。记录坐标单位是 1/2540 英寸（placeable 头
// Inch=2540），渲染时乘 SCALE 换成像素。
// 依赖：JSZip（重打包用）、字体 MTExtra/Symbol（@font-face 已在 css 里声明）。

const MM = { TEXT: 1, LOENGLISH: 2, LOMETRIC: 3, HIENGLISH: 4, HIMETRIC: 5, TWIPS: 6, ISOTROPIC: 7, ANISOTROPIC: 8 };

// GDI 记录号（MS-WMF 2.14）
const R = {
  EOF: 0x0000, NEWBITLEXT: 0x00f8, SETBKMODE: 0x0102, SETMAPMODE: 0x0103, SETROP2: 0x0104,
  SETPOLYFILLMODE: 0x0106, SETTEXTALIGN: 0x012e, SELECTOBJECT: 0x012d, SELECTCLIPREGION: 0x012c,
  DELETEOBJECT: 0x01f0, SETBKCOLOR: 0x0201, SETTEXTCOLOR: 0x0209, SETWINDOWORG: 0x020b,
  SETWINDOWEXT: 0x020c, SETVIEWPORTORG: 0x020f, SETVIEWPORTEXT: 0x0210, LINE: 0x020f2,
  LINETO: 0x0213, MOVETO: 0x0214, OFFSETCLIPRGNO: 0x0220, EXCLUDECLIPRECT: 0x0221,
  CREATEFONTINDIRECT: 0x02fb, CREATEBRUSHINDIRECT: 0x02fc, CREATEPENINDIRECT: 0x02fa,
  POLYGON: 0x0324, POLYLINE: 0x0325, POLYPOLYGON: 0x0538, RECTANGLE: 0x041b, ELLIPSE: 0x0410,
  TEXTOUT: 0x0521, EXTTEXTOUT: 0x0a32, ESCAPE: 0x0626, SAVEDC: 0x001e, RESTOREDC: 0x0127,
};

// ---------------------------------------------------------------- 解析

export function parseWmf(buf) {
  // buf: Uint8Array。返回 { bbox, inch, records: [{fn, args(Uint8Array)}] }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteOffset + buf.length);
  let off = 0;
  const bbox = { l: 0, t: 0, r: 0, b: 0 };
  let inch = 2540;
  if (buf.length > 22 && dv.getUint32(0, true) === 0x9ac6cdd7) {
    bbox.l = dv.getInt16(6, true); bbox.t = dv.getInt16(8, true);
    bbox.r = dv.getInt16(10, true); bbox.b = dv.getInt16(12, true);
    inch = dv.getUint16(14, true) || 2540;
    off = 22;
  }
  if (dv.getUint16(off, true) !== 0x0001) return null;
  const hs = dv.getUint16(off + 2, true) || 9; // 标准头 9 word（HeaderSize 以 word 计）
  off += hs * 2;

  const records = [];
  while (off + 6 <= buf.length) {
    const size = dv.getUint32(off, true);
    const fn = dv.getUint16(off + 4, true);
    if (size < 3 || off + size * 2 > buf.length) break;
    records.push({ fn, args: buf.subarray(off + 6, off + size * 2) });
    if (fn === R.EOF) break;
    off += size * 2;
  }
  return { bbox, inch, records };
}

// 参数读取器（16 位 GDI 优先，32 位兜底，见 probeFont）
const rd = (a, o) => ({
  i16: (k) => (o + k + 1 < a.length ? dv16(a, o + k) : 0),
  u16: (k) => (o + k + 1 < a.length ? dv16(a, o + k) : 0),
  i32: (k) => (o + k + 3 < a.length ? dv32(a, o + k) : 0),
  u8: (k) => (o + k < a.length ? a[o + k] : 0),
  cstr: (k) => {
    const bytes = [];
    for (let i = o + k; i < a.length && a[i]; i++) bytes.push(a[i]);
    if (!bytes.length) return '';
    if (bytes.every((b) => b < 0x80)) return String.fromCharCode(...bytes);
    try { return new TextDecoder('gbk').decode(new Uint8Array(bytes)); } // 宋体/黑体 等中文名按 GBK 存
    catch { return String.fromCharCode(...bytes); }
  },
});
const dv16 = (a, o) => new DataView(a.buffer, a.byteOffset + o, 2).getInt16(0, true);
const dv32 = (a, o) => new DataView(a.buffer, a.byteOffset + o, 4).getInt32(0, true);

// MathType/老 Word 写 16 位 LOGFONT：height i16@0 width i16@2 esc i16@4 ori i16@6
// weight u16@8 italic b@10 underline b@11 charset b@13 face cstr@18（宋体等按 GBK）
function readFont(a) {
  const r = rd(a, 0);
  const looks = (s) => /^[\x20-\x7e一-鿿]{2,}/.test(s) && !/[{}<>|\\]/.test(s);
  let name = r.cstr(18);
  if (!looks(name)) name = r.cstr(20); // 万一遇到 32 位 LOGFONT 的卷子
  return {
    height: r.i16(0), width: r.i16(2), escapement: r.i16(4), orientation: r.i16(6),
    weight: r.u16(8), italic: !!r.u8(10), name, charset: r.u8(13),
  };
}

// MathType 用 lfCharSet（不是字体名）表达"这段按 Symbol 编码画"：0x02 是标准
// SYMBOL_CHARSET，0xa1 是它给 π 这类高位字节用的标记——同一张 Times New Roman 的
// LOGFONT，charset=0x00 画 ASCII，charset=0xa1 时字节 0xF0 必须画成 π。
// GDI+ 真值实测：把这条记录的 0xa1 改成 0x00，π 立刻变成 ð。
function mathFontKind(f) {
  const name = (f.name || '').toLowerCase();
  if (f.charset === 0x02 || f.charset === 0xa1) return 'symbol';
  if (name.startsWith('mt extra')) return 'mtextra';
  if (name === 'symbol' || name.startsWith('symbol')) return 'symbol';
  return '';
}

// ---------------------------------------------------------------- 渲染

// 单位换算：1/2540 英寸 → CSS 像素（96dpi）× DPR 锐化
const SCALE = (96 / 2540) * 4; // 4× 过采样，最终按 CSS 尺寸显示

const Fallback = {
  'symbol': "'T2Symbol','Symbol',serif",
  'mt extra': "'T2MTExtra','Symbol',serif",
  'system': "sans-serif",
  'arial': "Arial,'Helvetica Neue',Helvetica,sans-serif",
  'tahoma': "Tahoma,sans-serif",
  'times new roman': "'Times New Roman',Times,serif",
};
function cssFont(f, px) {
  const name = (f.name || '').toLowerCase();
  let fam = 'serif';
  const kind = mathFontKind(f);
  if (kind === 'symbol') fam = Fallback['symbol'];
  else if (kind === 'mtextra') fam = Fallback['mt extra'];
  else for (const k of Object.keys(Fallback)) if (name === k || name.startsWith(k)) { fam = Fallback[k]; break; }
  if (name.includes('黑体') || name.includes('simhei')) fam = "'SimHei','Noto Sans CJK SC',sans-serif";
  if (name.includes('宋体') || name.includes('simsun')) fam = "SimSun,'Noto Serif CJK SC',serif";
  const bold = f.weight >= 600 ? 'bold ' : '';
  const ital = f.italic ? 'italic ' : '';
  return `${bold}${ital}${Math.max(1, px)}px ${fam}`;
}

function colorToCss(v) { return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`; }

export function renderWmf(parsed, ctx) {
  const { bbox } = parsed;
  const w = Math.max(1, Math.round((bbox.r - bbox.l) * SCALE));
  const h = Math.max(1, Math.round((bbox.b - bbox.t) * SCALE));
  ctx.canvas.width = w; ctx.canvas.height = h;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);

  // GDI 状态
  const obj = [];                 // 对象表（SelectObject 句柄）
  let pen = { style: 0, width: 1, color: '#000' };
  let brush = { style: 0, color: '#000' };
  let font = { height: -20, name: '' };
  let textColor = '#000', bkColor = '#fff', bkMode = 1, mapMode = MM.TEXT;
  let wOrg = [0, 0], wExt = [1, 1], vOrg = [0, 0], vExt = [1, 1];
  let align = 0, cp = [0, 0], current = [0, 0], pathPts = null;
  const base = { pen, brush, font, textColor, bkColor, bkMode, mapMode, wOrg, wExt, vOrg, vExt, align, cp, current };
  const stack = [];
  const freeSlot = (arr) => { for (let i = 0; i < arr.length; i++) if (!arr[i]) return i; arr.push(null); return arr.length - 1; };
  // 坐标映射。MathType 把内容画在「window extent 逻辑空间」（SetWindowExt 给的范围），
  // placeable bbox 则多了 ~10% 边距——GDI+ 与 Word 的预览都是把 window 空间铺满
  // bbox 来画的。因此：看到 SetWindowExt 就按 bbox/wExt 比例映射（x/y 各一个比例），
  // 字号、位移(DX)、线宽同比例放大；MM_TEXT 且无 extent 时 1:1。
  let extSet = false, wExtX = 1, wExtY = 1;
  const rx = () => extSet ? (bbox.r - bbox.l) / wExtX * SCALE : SCALE;
  const ry = () => extSet ? (bbox.b - bbox.t) / wExtY * SCALE : SCALE;
  const mapIso = () => mapMode === MM.ISOTROPIC || mapMode === MM.ANISOTROPIC;
  const X = (x) => mapIso() ? ((x - wOrg[0]) * (vExt[0] / wExt[0]) + vOrg[0]) * SCALE : extSet ? ((x - wOrg[0]) / wExtX) * (bbox.r - bbox.l) * SCALE : x * SCALE;
  const Y = (y) => mapIso() ? ((y - wOrg[1]) * (vExt[1] / wExt[1]) + vOrg[1]) * SCALE : extSet ? ((y - wOrg[1]) / wExtY) * (bbox.b - bbox.t) * SCALE : y * SCALE;

  for (const rec of parsed.records) {
    const a = rec.args, r = rd(a, 0);
    switch (rec.fn) {
      case R.SETBKMODE: bkMode = r.u16(0); break;
      case R.SETMAPMODE: mapMode = r.u16(0); break;
      case R.SETROP2: break;
      case R.SETPOLYFILLMODE: break;
      case R.SETTEXTALIGN: align = r.u16(0); break;
      case R.SELECTOBJECT: { const o = obj[r.u16(0)]; if (o) { if (o.kind === 'pen') pen = o; else if (o.kind === 'brush') brush = o; else if (o.kind === 'font') font = o; } break; }
      case R.SELECTCLIPREGION: break;
      case R.DELETEOBJECT: obj[r.u16(0)] = null; break;
      case R.SETBKCOLOR: bkColor = colorToCss(r.i32(0) & 0xffffff); break;
      case R.SETTEXTCOLOR: textColor = colorToCss(r.i32(0) & 0xffffff); break;
      case R.SETWINDOWORG: wOrg = [r.i16(2), r.i16(0)]; break; // 记录顺序 y@0 x@2
      case R.SETWINDOWEXT: { const yy = r.i16(0) || 1, xx = r.i16(2) || 1; wExt = [xx, yy]; wExtX = xx; wExtY = yy; extSet = (bbox.r - bbox.l) > 0 && (bbox.b - bbox.t) > 0; break; }
      case R.SETVIEWPORTORG: vOrg = [r.i16(0), r.i16(2)]; break;
      case R.SETVIEWPORTEXT: vExt = [r.i16(0) || 1, r.i16(2) || 1]; break;
      case R.SAVEDC: stack.push({ ...base, pen, brush, font }); break;
      case R.RESTOREDC: { const s = stack.pop(); if (s) { pen = s.pen; brush = s.brush; font = s.font; textColor = s.textColor; bkMode = s.bkMode; mapMode = s.mapMode; wOrg = s.wOrg; wExt = s.wExt; vOrg = s.vOrg; vExt = s.vExt; align = s.align; cp = s.cp; current = s.current; } break; }
            case R.CREATEFONTINDIRECT: obj[freeSlot(obj)] = { kind: 'font', ...readFont(a) }; break;
            case R.CREATEBRUSHINDIRECT: obj[freeSlot(obj)] = { kind: 'brush', style: r.u16(0), color: colorToCss(r.i32(2) & 0xffffff) }; break;
            case R.CREATEPENINDIRECT: obj[freeSlot(obj)] = { kind: 'pen', style: r.u16(0), width: Math.abs(r.i16(2)) || 1, color: colorToCss(r.i32(4) & 0xffffff) }; break;
      case R.MOVETO: {
        // current/pts 保持原始坐标（线段绘制时再换算）；cp 存设备坐标，
        // 因为 TA_UPDATECP 的文本直接以 cp 为落点，不能再二次缩放。
        current = [r.i16(2), r.i16(0)];
        cp = [X(current[0]), Y(current[1])];
        break;
      }
      case R.LINETO: {
        const p = [r.i16(2), r.i16(0)];
        ctx.strokeStyle = pen.color; ctx.lineWidth = Math.max(1, pen.width * ry());
        ctx.beginPath(); ctx.moveTo(X(current[0]), Y(current[1])); ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke();
        current = p; cp = [X(p[0]), Y(p[1])]; break;
      }
      case R.RECTANGLE: {
        const x1 = r.i16(2), y1 = r.i16(0), x2 = r.i16(6), y2 = r.i16(4);
        strokeFillRect(x1, y1, x2, y2); break;
      }
      case R.ELLIPSE: {
        const x1 = r.i16(2), y1 = r.i16(0), x2 = r.i16(6), y2 = r.i16(4);
        ctx.beginPath();
        ctx.ellipse((X(x1) + X(x2)) / 2, (Y(y1) + Y(y2)) / 2, Math.abs(X(x2) - X(x1)) / 2, Math.abs(Y(y2) - Y(y1)) / 2, 0, 0, Math.PI * 2);
        paint(); break;
      }
      case R.POLYLINE: case R.POLYGON: case R.POLYPOLYGON: {
        // MS-WMF 2.3.20/2.3.21：Count@0，随后第一个点 X@2 Y@4、每点 4 字节。
        // 早先把 Y 写成 0+i*4，等于把 Count 当成首点的 Y，整串坐标偏 2 字节 ——
        // MathType 的根号是多边形，偏掉就糊成一坨实心黑块。
        const n = r.u16(0); const pts = [];
        for (let i = 0; i < n; i++) pts.push([r.i16(2 + i * 4), r.i16(4 + i * 4)]);
        if (rec.fn === R.POLYPOLYGON) { /* 少见：按多组画，第一字是组数 */ }
        ctx.beginPath();
        pts.forEach(([px, py], i) => i ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py)));
        if (rec.fn !== R.POLYLINE) ctx.closePath();
        paint();
        if (pts.length) { current = pts[0]; cp = [X(current[0]), Y(current[1])]; }
        break;
      }
      case R.TEXTOUT: case R.EXTTEXTOUT: {
        // 字段布局（MS-WMF 2.3.3.1 / 2.3.3.4，别按直觉写）：
        //   ExtTextOut: y@0 x@2 cch@4 opts@6，裁剪/不透明选项时多 8 字节矩形，文本在其后
        //   TextOut   : cch@0 文本@2，YStart 在 2+cch，XStart 在 4+cch
        let n, opt = 0, x, y, tAt;
        if (rec.fn === R.TEXTOUT) {
          n = r.u16(0);
          y = a.length > 3 + n ? dv16(a, 2 + n) : 0;
          x = a.length > 5 + n ? dv16(a, 4 + n) : 0;
          tAt = 2;
        } else {
          y = r.i16(0); x = r.i16(2); n = r.u16(4); opt = r.u16(6);
          tAt = (opt & 6) ? 16 : 8; // ETO_OPAQUE|ETO_CLIPPED 带矩形
        }
        const bytes = a.subarray(tAt, tAt + n); // ETO_CLIPPED 等 options 罕见，统一按 8-bit 取 n 字节
        let text;
        const kind = mathFontKind(font);
        if (kind) {
          // T2Symbol / T2MTExtra 的 Windows cmap(p3/e0) 只覆盖 U+F020-U+F0FE。
          // 直接发原始字节码位能不能出字，取决于引擎会不会回退到字体里的 Mac(p1/e0)
          // 子表——这是引擎行为，不能赌，所以显式加 0xF000 命中 p3/e0。
          // 唯一例外 0xF0(π)：两张表都没有它，GDI 的 SYMBOL 码页把它折到 0x70，照做。
          text = Array.from(bytes, (b) => String.fromCharCode(0xf000 + (b === 0xf0 ? 0x70 : b))).join('');
        } else {
          try { text = new TextDecoder(gbkFont(font) ? 'gbk' : 'latin1').decode(bytes); }
          catch { text = Array.from(bytes, (b) => String.fromCharCode(b)).join(''); }
        }
        if (!text) break;
        const px = Math.abs(font.height) * ry() * (font.height < 0 ? 1 : 0.9);
        ctx.font = cssFont(font, px);
        ctx.fillStyle = textColor;
        // TA_LEFT=0 TA_RIGHT=2 TA_CENTER=6；TA_TOP=0 TA_BOTTOM=8 TA_BASELINE=24
        const ha = align & 6;
        ctx.textAlign = ha === 6 ? 'center' : ha === 2 ? 'right' : 'left';
        const va = align & 24;
        ctx.textBaseline = va === 24 ? 'alphabetic' : va === 8 ? 'bottom' : 'top';
        const [cx0, cy0] = (align & 1) ? cp : [X(x), Y(y)]; // TA_UPDATECP：用当前位置
        // MathType 在文本后附加逐字位移（lpDx 语义：画下一字前把当前位置移动 dx
        // 个逻辑单位）。字符串按 MS-WMF 规则补齐到偶数字节，DX 从补齐后开始——
        // 按字面 cch 读会错位到奇偏移、读出垃圾位移。
        // 注意 cch 是字节数：宋体这类双字节 run 里 4 字节只有 2 个字，
        // lpDx 也是 2 项。按 n 判断长度会把整段当成一个字画在同一个起点，
        // 于是"such that"竖线全部挤到前一处公式里（实测百校联考第 1 题 B 段丢竖线）。
        const dxAt = tAt + n + (n & 1);
        const nChars = text.length;
        const hasDx = rec.fn === R.EXTTEXTOUT && a.length >= dxAt + nChars * 2;
        if (hasDx) {
          let cx = cx0;
          for (let ci = 0; ci < nChars; ci++) {
            ctx.fillText(text[ci], cx, cy0);
            cx += dv16(a, dxAt + ci * 2) * rx();
          }
          if (align & 1) cp = [cx, cy0];
        } else {
          ctx.fillText(text, cx0, cy0);
          if (align & 1) cp = [cx0 + ctx.measureText(text).width, cy0]; // 更新 CP
        }
        break;
      }
      case R.ESCAPE: break; // MathType 的 STARTDOC/NEWFRAME/注释：整体跳过
      default: break;       // 未知记录：跳过不抛错
    }
  }
  function gbkFont(f) { const n = (f.name || '').toLowerCase(); return n.includes('宋') || n.includes('hei') || n.includes('kai'); }
  function strokeFillRect(x1, y1, x2, y2) {
    const bx = Math.min(X(x1), X(x2)), by = Math.min(Y(y1), Y(y2));
    const bw = Math.abs(X(x2) - X(x1)), bh = Math.abs(Y(y2) - Y(y1));
    ctx.beginPath(); ctx.rect(bx, by, bw, bh); paint();
  }
  function paint() {
    if (brush.style === 0 && brush.color !== 'rgb(255,255,255)') { ctx.fillStyle = brush.color; ctx.fill(); }
    if (pen.style !== 4) { ctx.strokeStyle = pen.color; ctx.lineWidth = Math.max(1, pen.width * ry()); ctx.stroke(); }
  }
}

export function wmfToCanvas(buf, ctxCap) {
  const parsed = parseWmf(buf);
  if (!parsed || !parsed.records.length) return null;
  const c = ctxCap || document.createElement('canvas');
  const ctx = c.getContext('2d');
  renderWmf(parsed, ctx);
  return c;
}

// ---------------------------------------------------------------- docx 重打包
// 两件事，缺一公式就空白：
//  1) MathType 公式藏在 <w:object>（OLE）里，而 docx-preview 的 run 分发只有
//     case "pict"/"drawing"、没有 case "object" —— 整个对象被静默丢弃。
//     把 w:object 改写成 w:pict（内容还是同一个 v:shape/v:imagedata，
//     删掉浏览器用不上的 o:OLEObject 引用），让它走 docx-preview 已有的 VML 路径。
//  2) 公式预览图 word/media/*.wmf 浏览器画不了：换成 PNG（同路径同扩展名，
//     docx-preview 按内容识别图像），其余部件原样保留。
// 返回新 Blob；文档里既没有 WMF 也没有 w:object 时返回 null（原件直通）。

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** document.xml / header*.xml / footer*.xml 里 w:object → w:pict。无需改写时返回 null。 */
function unwrapMathTypeObjects(xmlText) {
  if (xmlText.indexOf('<w:object') < 0) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const objs = [...doc.getElementsByTagNameNS(W_NS, 'object')];
  if (!objs.length) return null;
  for (const o of objs) {
    for (const kid of [...o.childNodes]) {
      if (kid.nodeType === 1 && (kid.localName === 'OLEObject' || kid.localName === 'lockedCanvas')) kid.remove();
    }
    const pict = doc.createElementNS(W_NS, 'w:pict');
    while (o.firstChild) pict.appendChild(o.firstChild);
    o.parentNode.replaceChild(pict, o);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** 需要重打包的 XML 部件名。 */
const partName = (n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n);

export async function repackDocxWithWmf(blob) {
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(blob);
  const wmfFiles = Object.keys(zip.files).filter((n) => /\.wmf$/i.test(n));
  // 第一步：XML 改写（哪怕没有 WMF——预览图可能本来就是 PNG——也要做，否则对象照样丢）
  let rewrote = false;
  for (const name of Object.keys(zip.files).filter(partName)) {
    try {
      const xml = await zip.file(name).async('string');
      const fixed = unwrapMathTypeObjects(xml);
      if (fixed) { zip.file(name, fixed); rewrote = true; }
    } catch { /* 单个部件解析失败：放弃改写该部件，正文照常 */ }
  }
  if (!wmfFiles.length && !rewrote) return null;
  // 公式字体必须显式加载后再画：canvas 的 fillText 触发字体加载是异步的、
  // 不会等（fonts.ready 只覆盖"页面上正在用的"字体），不 preload 就会画成缺字方框。
  if (document.fonts && document.fonts.load) {
    try { await Promise.all(['20px T2Symbol', '20px T2MTExtra', 'italic 20px T2Symbol', 'italic 20px T2MTExtra'].map((f) => document.fonts.load(f))); } catch { /* 忽略 */ }
  }
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* 忽略 */ } }
  // 第二步：WMF → PNG。注意不能只换字节不换扩展名 —— docx-preview 按扩展名
  // 决定 data URI 的 MIME（.wmf → image/x-wmf），浏览器不认这种类型，图会空白。
  // 所以把媒体文件改名为 .png，并同步改所有 .rels 里的引用。
  const renamed = new Map(); // 原 wmf 文件名(小写) → 新 png 文件名
  for (const name of wmfFiles) {
    const data = await zip.file(name).async('uint8array');
    const c = wmfToCanvas(data);
    if (!c || !c.width || !c.height) continue; // 解析失败：保留原件（宁可空白不报错）
    const png = dataURLtoBin(c.toDataURL('image/png'));
    let target = name.replace(/\.wmf$/i, '.png');
    if (zip.file(target)) target = name.replace(/\.wmf$/i, '') + '_wmf.png'; // 极罕见：media 里已有同名 png
    if (zip.file(target)) continue;
    zip.remove(name);
    zip.file(target, png, { binary: true });
    renamed.set(basename(name), basename(target));
  }
  if (renamed.size) {
    for (const relName of Object.keys(zip.files).filter((n) => /\.rels$/i.test(n))) {
      try {
        const xml = await zip.file(relName).async('string');
        let hit = false;
        const fixed = xml.replace(/Target="([^"]*?\.wmf)"/gi, (m, p) => {
          const t = renamed.get(basename(p));
          if (!t) return m;
          hit = true;
          return `Target="${p.slice(0, Math.max(0, p.lastIndexOf('/') + 1))}${t}"`;
        });
        if (hit) zip.file(relName, fixed);
      } catch { /* 单个 rels 解析失败：跳过 */ }
    }
  }
  return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

function dataURLtoBin(u) {
  const b64 = u.slice(u.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
