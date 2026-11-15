// tree2 × Navidrome 自定义外观 v5
//   1) ±15s：固定浮层（不再依赖 Navi 的播放条 DOM）
//   2) 左下角宠物 gif，可拖动，idle/load/play 三态
//   3) 保留 Navidrome 分享页原有的封面和播放布局
//   4) 分享页自动起播（用户一操作就交还控制权）
//   5) 左上角「返回资料库」
//
// v5 关键修复（v4 为什么不工作）：
//   · Navidrome 0.64.2 里 "NDAudioPlayer" 只是 JSS 主题键，不是 DOM class；
//     播放条上的播放键是 <span class="player-icons">，不是 <button>；
//   · 音频由 Howler 用 new Audio() 创建，压根不在 DOM 里，
//     所以 document.querySelectorAll('audio') 是空的。
//   现在直接在 HTMLMediaElement.prototype.play/pause 上挂钩子，
//   任何方式创建的音频元素都能抓到，播放状态和 seek 目标都有了。
(function () {
  if (window.__t2ND) return;
  window.__t2ND = true;

  var STEP = 15;
  var ASSET = '/assets/';
  var FAVICON = '/assets/facivon.svg';
  // 桌宠可选：往 /assets/ 放一个 pet.gif 就会出现（可拖动），不放就完全没有、零流量。
  // 原来默认带的三个绝区零动图共 3.7 MB，已删。
  var PET_GIF = ASSET + 'pet.gif';
  // 点过桌宠右上角的 × 之后记在这里，之后就不再挂载；想恢复：控制台执行
  // localStorage.removeItem('t2PetOff') 再刷新。
  var PET_OFF_KEY = 't2PetOff';
  var IS_MUSIC = location.pathname.indexOf('/music/') === 0;
  var IS_SHARE = location.pathname.indexOf('/share/') !== -1;

  var lastAudio = null;
  var playing = false;

  /* ---------------- 抓音频元素 + 播放状态 ---------------- */

  function watch(a) {
    if (!a || a.__t2Watched) return;
    a.__t2Watched = true;
    ['play', 'pause', 'playing', 'ended', 'waiting', 'canplay'].forEach(function (t) {
      a.addEventListener(t, function () {
        playing = !a.paused;
        paint();
      });
    });
  }

  (function patchMedia() {
    var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || proto.__t2Patched) return;
    proto.__t2Patched = true;
    var origPlay = proto.play;
    var origPause = proto.pause;
    proto.play = function () {
      lastAudio = this;
      if (window.__t2Rate && window.__t2Rate !== 1) { try { this.playbackRate = window.__t2Rate; } catch (e) {} }
      watch(this);
      var r = origPlay.apply(this, arguments);
      if (r && typeof r.then === 'function') {
        r.then(
          function () { playing = true; paint(); },
          function () { /* autoplay 被拦，保持原状态 */ },
        );
      } else {
        playing = true;
        paint();
      }
      return r;
    };
    proto.pause = function () {
      var r = origPause.apply(this, arguments);
      playing = false;
      paint();
      return r;
    };
  })();

  function audioEl() {
    if (lastAudio) {
      watch(lastAudio);
      return lastAudio;
    }
    var list = document.querySelectorAll('audio, video');
    for (var i = 0; i < list.length; i++) {
      watch(list[i]);
      if (!list[i].paused) return list[i];
    }
    return list[0] || null;
  }

  function isPlaying() {
    var a = audioEl();
    if (a) return !a.paused;
    return playing;
  }

  function seek(step) {
    var a = audioEl();
    if (!a) return;
    var d = isFinite(a.duration) ? a.duration : 0;
    var t = (a.currentTime || 0) + step;
    if (t < 0) t = 0;
    if (d && t > d) t = d;
    try {
      a.currentTime = t;
    } catch (e) {}
  }

  /* ---------------- 统一刷新视觉 ---------------- */

  var pet = null;
  var petClose = null;

  function paint() {
    var on = isPlaying();
    setPet(on ? 'play' : 'idle');
    var discs = document.querySelectorAll('.t2-nd-disc');
    for (var i = 0; i < discs.length; i++) discs[i].classList.toggle('is-playing', on);
  }

  /* ---------------- ±15s 嵌进播放条 ----------------
     Navidrome 桌面播放条的真实结构（0.64.2 打包产物里确认的）：
       <div class="player-content"><span class="group">
         <span class="group prev-audio" title="Previous track">…</span>
         <span class="group play-btn"   title="Click to play/pause">…</span>
         <span class="group next-audio" title="Next track">…</span>
       </span>…</div>
     目标：[−15s] 插到 prev-audio 前面，[+15s] 插到 next-audio 后面。 */

  /**
   * 关键：邻居是「span.group > svg」，文字直接放在 span 里会因为字体基线比 SVG 图形
   * 中心低而永远对不齐（试过 vertical-align / align-self / transform 都治标）。
   * 所以这里把文字画进 <svg><text>，元素类型和邻居一致，对齐规则就天然相同。
   */
  function makeSkipSpan(step) {
    var s = document.createElement('span');
    s.className = 'group t2-nd-ctrl t2-nd-skip';
    s.dataset.skip = String(step);
    s.title = (step < 0 ? '后退' : '前进') + STEP + '秒';
    s.setAttribute('aria-label', (step < 0 ? '后退' : '前进') + STEP + '秒');
    var label = (step < 0 ? '\u2212' : '+') + STEP + 's';
    s.innerHTML =
      '<svg width="40" height="22" viewBox="0 0 40 22" aria-hidden="true" focusable="false">' +
      '<text x="20" y="15" text-anchor="middle" font-size="12" font-weight="700" ' +
      'font-family="system-ui,-apple-system,Segoe UI,sans-serif" fill="currentColor" ' +
      'letter-spacing="-0.3">' +
      label +
      '</text></svg>';
    s.addEventListener('click', function (e) {
      e.stopPropagation();
      seek(step);
    });
    return s;
  }

  function integrateSkip() {
    if (!document.querySelector('.t2-nd-skip')) {
      var prev = findControl('prev');
      var next = findControl('next');
      var plus = null;
      if (prev && next) {
        prev.parentElement.insertBefore(makeSkipSpan(-STEP), prev);
        plus = makeSkipSpan(STEP);
        next.parentElement.insertBefore(plus, next.nextSibling);
      } else {
        // 没有上一首/下一首（单曲分享页）：插在播放键两侧
        var play = findControl('play');
        if (play && play.parentElement) {
          play.parentElement.insertBefore(makeSkipSpan(-STEP), play);
          plus = makeSkipSpan(STEP);
          play.parentElement.insertBefore(plus, play.nextSibling);
        }
      }
      // 音量 + 倍速 + 收藏不塞这行：它们有自己的一行，放进度条上面（mountToolsRow）
    }
    alignSkips();
  }

  /* ---------------- 倍速 | 音量 | 收藏：进度条上方的一行 ---------------- */

  /** 收藏键只对本地文件显示：local-<sha256>.<ext> 能还原出 tree2 的存储键 */
  function favKeyFromLocation() {
    var m = /\/music\/share\/([^/?#]+)/.exec(location.pathname);
    var id = m && decodeURIComponent(m[1]);
    var mm = id && /^local-([0-9a-f]{64})(\.[a-z0-9]{1,8})$/i.exec(id);
    return mm ? mm[1].slice(0, 2) + '/' + mm[1] + mm[2] : null;
  }
  function favHas(k) {
    try {
      return (JSON.parse(localStorage.getItem('tree2.fav') || '[]')).indexOf(k) !== -1;
    } catch (e) { return false; }
  }
  function favToggle(k) {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('tree2.fav') || '[]'); } catch (e) {}
    var i = arr.indexOf(k);
    if (i === -1) arr.push(k);
    else arr.splice(i, 1);
    try { localStorage.setItem('tree2.fav', JSON.stringify(arr)); } catch (e) {}
    return i === -1;
  }

  /** 收藏：五角星（跟资料库里的 ★/☆ 同款语义），实心=已收藏；共用同一个 localStorage */
  function makeFavSpan() {
    var k = favKeyFromLocation();
    if (!k) return null;
    var s = document.createElement('span');
    s.className = 'group t2-nd-ctrl t2-nd-fav';
    s.dataset.k = k;
    s.setAttribute('role', 'button');
    s.setAttribute('aria-label', '收藏');
    var paint = function (on) {
      s.title = on ? '已收藏，点按取消' : '收藏到本浏览器';
      s.querySelector('.t2-nd-fav-path').setAttribute('fill', on ? '#e8a838' : 'none');
    };
    s.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path class="t2-nd-fav-path" ' +
      'd="M12 2.8l2.8 5.6 6.2.9-4.5 4.4 1.1 6.2L12 17l-5.6 2.9 1.1-6.2-4.5-4.4 6.2-.9z" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
      '</svg>';
    paint(favHas(k));
    s.addEventListener('click', function (e) {
      e.stopPropagation();
      paint(favToggle(s.dataset.k));
    });
    return s;
  }

  /**
   * 收藏 | 倍速 | 音量 一行，插在进度条上面。
   * 播放条就只剩 ±15s 和播放键，天然居中，不用再垫配重。
   */
  function mountToolsRow() {
    var progress = document.querySelector('.react-jinke-music-player-mobile-progress');
    if (!progress || document.querySelector('.t2-nd-tools')) return;
    var row = document.createElement('div');
    row.className = 't2-nd-tools';
    var fav = makeFavSpan();
    var rate = makeRateSpan();
    var vol = makeVolSpan();
    if (fav) row.appendChild(fav);
    if (rate) row.appendChild(rate);
    if (vol) row.appendChild(vol);
    progress.parentElement.insertBefore(row, progress);
  }

  /**
   * 垂直对齐：参照物取**图标自身的 <svg>**（glyph 的真实盒子），而不是外层 span。
   * 原因：span 可能被行盒撑高，盒子中心和图形中心不是一回事；
   * 按像素量过，图标 glyph 中心和它外层 span 中心能差十几像素。
   * 差值写成行内 transform，优先级最高，不受 Navi 样式影响。
   */
  function alignSkips() {
    // 只对齐播放条里的 ±15s（.t2-nd-skip）。倍速/音量/收藏另有自己的一行，
    // 不参与这套对齐——之前用 .t2-nd-ctrl 全量匹配，把它们拉去跟播放条
    // 图标对齐，表现成"图标飞出几百像素、每秒重算着飘"。
    var skips = document.querySelectorAll('.t2-nd-skip');
    if (!skips.length) return;
    var refSvg =
      document.querySelector('.prev-audio svg') ||
      document.querySelector('.next-audio svg') ||
      document.querySelector('.play-btn svg');
    if (!refSvg) return;
    var rr = refSvg.getBoundingClientRect();
    if (!rr.height) return;
    var refMid = rr.top + rr.height / 2;
    var last = 0;
    for (var i = 0; i < skips.length; i++) {
      var s = skips[i];
      s.style.transform = 'none';
      var svg = s.querySelector('svg');
      var box = (svg || s).getBoundingClientRect();
      if (!box.height) continue;
      var dy = Math.round((refMid - (box.top + box.height / 2)) * 10) / 10;
      last = dy;
      s.style.transform = dy ? 'translateY(' + dy + 'px)' : 'none';
    }
    window.__t2Align = { dy: last, at: Date.now() };
  }

  /* ---- 控件查找：class / title / aria-label / 图标路径 四路兜底 ---- */

  var PREV_WORDS = ['previous', 'prev', '\u4e0a\u4e00\u9996'];
  var NEXT_WORDS = ['next', '\u4e0b\u4e00\u9996'];
  var PLAY_WORDS = ['play', 'pause', '\u64ad\u653e', '\u6682\u505c'];
  var ICON = { prev: 'M6 6h2v12H6', next: 'M6 18l8.5-6L6 6' };

  function labelOf(el) {
    if (!el || !el.getAttribute) return '';
    return ((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  }

  function isControl(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    return t === 'button' || t === 'a' || t === 'span' || t === 'div' || t === 'li';
  }

  function byWords(words, scope) {
    var list = (scope || document).querySelectorAll('[title],[aria-label]');
    for (var i = 0; i < list.length; i++) {
      if (!isControl(list[i])) continue;
      var l = labelOf(list[i]);
      for (var w = 0; w < words.length; w++) if (l.indexOf(words[w]) !== -1) return list[i];
    }
    return null;
  }

  function byIconPath(prefix) {
    var paths = document.querySelectorAll('svg path');
    for (var i = 0; i < paths.length; i++) {
      var d = paths[i].getAttribute('d') || '';
      if (d.indexOf(prefix) !== 0) continue;
      var host = paths[i];
      // 往上找一层"能点的壳"：优先带 audio/play 语义的类，其次 button / span.group
      var wrap = null;
      try {
        wrap = host.closest('.prev-audio, .next-audio, .play-btn, .player-icons, span.group, button, [role="button"]');
      } catch (e) {}
      return wrap || host.parentElement || null;
    }
    return null;
  }

  function findControl(kind) {
    if (kind === 'prev') {
      return document.querySelector('.prev-audio') || byIconPath(ICON.prev) || byWords(PREV_WORDS);
    }
    if (kind === 'next') {
      return document.querySelector('.next-audio') || byIconPath(ICON.next) || byWords(NEXT_WORDS);
    }
    return document.querySelector('.play-btn') || document.querySelector('.player-icons') || byWords(PLAY_WORDS);
  }

  /* ---------------- 一次性探针：把真实 DOM 结构打到 nginx 日志，便于无浏览器排查 ---------------- */
  function probe() {
    if (!IS_MUSIC) return;
    if (location.search.indexOf('t2probe') === -1) return; // 需要显式带参数才发，平时不发
    try {
      var controls = [];
      var list = document.querySelectorAll('[title],[aria-label]');
      for (var i = 0; i < list.length && controls.length < 30; i++) {
        var el = list[i];
        var t = el.getAttribute('title');
        var a = el.getAttribute('aria-label');
        if (!t && !a) continue;
        controls.push(el.tagName.toLowerCase() + '|' + String(el.className).slice(0, 24) + '|' + (t || '') + '|' + (a || ''));
      }
      // 几何数据：父容器布局 + 各控件坐标，直接定位"高度不对"的真正原因
      var geo = null;
      try {
        var play = findControl('play');
        var prev = findControl('prev');
        var next = findControl('next');
        var skips = document.querySelectorAll('.t2-nd-ctrl');
        function box(el) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return [Math.round(r.top), Math.round(r.height), Math.round(r.left), Math.round(r.width)];
        }
        var par = play && play.parentElement;
        var cs = par ? getComputedStyle(par) : null;
        geo = {
          v: 8,
          align: window.__t2Align || null,
          parent: par ? par.tagName.toLowerCase() + '.' + String(par.className).slice(0, 30) : null,
          parentDisplay: cs ? cs.display + '/' + cs.alignItems + '/' + cs.flexWrap : null,
          play: box(play),
          prev: box(prev),
          next: box(next),
          skip0: box(skips[0]),
          skip1: box(skips[1]),
          skipTransform: skips[0] ? getComputedStyle(skips[0]).transform : null,
          skipSelfAlign: skips[0] ? getComputedStyle(skips[0]).alignSelf : null,
          skipDisplay: skips[0] ? getComputedStyle(skips[0]).display : null,
        };
      } catch (e) {
        geo = { err: String(e && e.message) };
      }

      var info = {
        p: location.pathname,
        pc: !!document.querySelector('.player-content'),
        pa: !!document.querySelector('.prev-audio'),
        na: !!document.querySelector('.next-audio'),
        pb: !!document.querySelector('.play-btn'),
        pi: document.querySelectorAll('.player-icons').length,
        jinke: !!document.querySelector('[class*="react-jinke"]'),
        audio: document.querySelectorAll('audio').length,
        g: geo,
        c: controls,
      };
      var url = '/t2probe?d=' + encodeURIComponent(JSON.stringify(info));
      (window.fetch ? fetch(url, { mode: 'no-cors', cache: 'no-store' }) : null) || null;
    } catch (e) {}
  }

  /* ---------------- 音量：和 ±15s 同一行的单个图标，点开是竖直滑条 ---------------- */

  var volValue = 0.9;

  function readVol() {
    try {
      var v = parseFloat(localStorage.getItem('t2Vol'));
      if (isFinite(v) && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return 0.9;
  }

  function applyVol(v) {
    volValue = Math.max(0, Math.min(1, v));
    var a = audioEl();
    if (a) {
      try {
        a.muted = false;
        a.volume = volValue;
      } catch (e) {}
    }
    try {
      localStorage.setItem('t2Vol', String(volValue));
    } catch (e) {}
    var range = document.querySelector('.t2-nd-vol-range');
    if (range && Math.abs(parseFloat(range.value) - volValue) > 0.005) range.value = String(volValue);
    var wave = document.querySelector('.t2-nd-vol-wave');
    if (wave) wave.style.display = volValue > 0.001 ? '' : 'none';
  }

  /** 音量：小喇叭图标，点开向右弹出横向滑条 */
  function makeVolSpan() {
    var s = document.createElement('span');
    s.className = 'group t2-nd-ctrl t2-nd-vol-inline';
    s.title = '音量';
    s.setAttribute('aria-label', '音量');
    s.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>' +
      '<path class="t2-nd-vol-wave" d="M16 8.6a4.8 4.8 0 0 1 0 6.8M18.6 6a8.2 8.2 0 0 1 0 12" ' +
      'stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>' +
      '</svg>' +
      '<div class="t2-nd-vol-pop" hidden>' +
      '<input class="t2-nd-vol-range" type="range" min="0" max="1" step="0.01" aria-label="音量">' +
      '<button type="button" class="t2-nd-vol-mute" aria-label="静音">' +
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>' +
      '<path class="t2-nd-vol-mute-wave" d="M16 8.6a4.8 4.8 0 0 1 0 6.8" stroke="currentColor" ' +
      'stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '</svg></button>' +
      '</div>';

    var pop = s.querySelector('.t2-nd-vol-pop');
    var range = s.querySelector('.t2-nd-vol-range');
    var mute = s.querySelector('.t2-nd-vol-mute');

    range.value = String(readVol());
    range.addEventListener('input', function () {
      applyVol(parseFloat(range.value));
    });
    range.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
    });
    range.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    mute.addEventListener('click', function (e) {
      e.stopPropagation();
      applyVol(volValue > 0.001 ? 0 : 0.9);
    });
    s.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) applyVol(readVol());
    });
    return s;
  }

    /* ---------------- 倍速（听力练习刚需） ----------------
       目标值存 localStorage，每 800ms 把所有媒体元素的倍速对齐一次
       （Howler 换轨或新元素出现也能跟上）。 */
    var t2Rate = 1;
    try { t2Rate = parseFloat(localStorage.getItem('t2Rate')) || 1; } catch (e) {}
    window.__t2Rate = t2Rate;
    function applyRateToMedia(media) {
      if (media && media.playbackRate !== t2Rate) {
        try { media.playbackRate = t2Rate; } catch (e) {}
      }
    }
    function t2ApplyRate() {
      window.__t2Rate = t2Rate;
      applyRateToMedia(lastAudio);
      document.querySelectorAll('audio, video').forEach(applyRateToMedia);
    }
    setInterval(t2ApplyRate, 800);
    function t2CycleRate() {
      var steps = [1, 1.25, 1.5, 2, 0.75];
      t2Rate = steps[(steps.indexOf(t2Rate) + 1) % steps.length];
      try { localStorage.setItem('t2Rate', String(t2Rate)); } catch (e) {}
      t2ApplyRate();
      var label = document.getElementById('t2-rate-label');
      if (label) label.textContent = t2Rate + 'x';
      var span = document.querySelector('.t2-nd-rate');
      if (span) span.title = '当前倍速 ' + t2Rate + 'x，点按切换';
    }

    /** 倍速：跟 ±15s 同款的 span>svg 文字控件，点一下换下一档 */
    function makeRateSpan() {
      var s = document.createElement('span');
      s.className = 'group t2-nd-ctrl t2-nd-rate';
      s.title = '听力倍速：点按切换（0.75/1/1.25/1.5/2）';
      s.setAttribute('aria-label', '播放倍速');
      s.innerHTML =
        '<svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true" focusable="false">' +
        '<text id="t2-rate-label" x="17" y="15" text-anchor="middle" font-size="12" font-weight="700" ' +
        'font-family="system-ui,-apple-system,Segoe UI,sans-serif" fill="currentColor" letter-spacing="-0.3">' +
        t2Rate +
        'x</text></svg>';
      s.addEventListener('click', function (e) {
        e.stopPropagation();
        t2CycleRate();
      });
      return s;
    }

  /* ---------------- 返回资料库 ---------------- */

  // 右上角统一放倍速和返回，避免一个在左上、一个在左下的割裂感
  function topBar() {
    var bar = document.querySelector('.t2-nd-top');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 't2-nd-top';
      document.body.appendChild(bar);
    }
    return bar;
  }

  function mountBack() {
    if (!IS_MUSIC) return;
    if (document.querySelector('.t2-nd-back')) return;
    var a = document.createElement('a');
    a.className = 't2-nd-back';
    a.href = location.pathname.indexOf('/music/share/local-') === 0 ? '/tree2/index.html?api=reset' : '/';
    a.textContent = '\u2190 \u8d44\u6599\u5e93';
    a.setAttribute('aria-label', '返回资料库');
    topBar().appendChild(a);
  }

  /* ---------------- 宠物 gif（可拖动） ---------------- */

  function petPos() {
    try {
      var raw = localStorage.getItem('t2PetPos');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { left: 16, bottom: 96 };
  }

  function savePetPos(p) {
    try {
      localStorage.setItem('t2PetPos', JSON.stringify(p));
    } catch (e) {}
  }

  function petOff() {
    try {
      return localStorage.getItem(PET_OFF_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function removePet() {
    if (pet && pet.parentNode) pet.parentNode.removeChild(pet);
    if (petClose && petClose.parentNode) petClose.parentNode.removeChild(petClose);
    pet = null;
    petClose = null;
  }

  // 关闭按钮跟着宠物走（宠物可拖动）
  function placeClose() {
    if (!pet || !petClose) return;
    var r = pet.getBoundingClientRect();
    petClose.style.left = r.left + r.width - 14 + 'px';
    petClose.style.top = r.top - 6 + 'px';
  }

  function hidePet() {
    try {
      localStorage.setItem(PET_OFF_KEY, '1');
    } catch (e) {}
    removePet();
  }

  function mountPet() {
    if (pet || !document.body || !IS_MUSIC) return;
    if (petOff()) return;
    // 素材优先级：assets/pet.gif（自传的动图）> facivon.svg（页面自带的 1.6KB 图标，零额外流量）。
    // 以前默认带的三个绝区零动图共 3.7 MB，已删。
    var probe = new Image();
    probe.onload = function () { mountPetImg(PET_GIF); };
    probe.onerror = function () { mountPetImg(FAVICON); };
    probe.src = PET_GIF;
  }

  function mountPetImg(src) {
    if (pet || !document.body) return;
    if (petOff()) return;
    pet = document.createElement('img');
    pet.className = 't2-nd-pet';
    pet.alt = '';
    pet.draggable = false;
    pet.src = src;
    document.body.appendChild(pet);
    var p = petPos();
    pet.style.left = p.left + 'px';
    pet.style.bottom = p.bottom + 'px';
    makeDraggable(pet);

    petClose = document.createElement('button');
    petClose.type = 'button';
    petClose.className = 't2-nd-pet-close';
    petClose.textContent = '\u00d7';
    petClose.title = '\u9690\u85cf\u684c\u5ba0';
    petClose.setAttribute('aria-label', '\u9690\u85cf\u684c\u5ba0');
    petClose.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      hidePet();
    });
    document.body.appendChild(petClose);
    placeClose();
  }

  function makeDraggable(el) {
    var dragging = false;
    var sx = 0;
    var sy = 0;
    var ol = 0;
    var ob = 0;
    el.addEventListener('pointerdown', function (e) {
      dragging = true;
      el.classList.add('dragging');
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      sx = e.clientX;
      sy = e.clientY;
      var r = el.getBoundingClientRect();
      ol = r.left;
      ob = window.innerHeight - r.bottom;
      e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var left = ol + (e.clientX - sx);
      var bottom = ob - (e.clientY - sy);
      left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, left));
      bottom = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, bottom));
      el.style.left = left + 'px';
      el.style.bottom = bottom + 'px';
      placeClose();
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      var r = el.getBoundingClientRect();
      savePetPos({ left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.bottom) });
      e.preventDefault();
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function setPet(name) {
    if (!pet) return;
    pet.dataset.state = name; // 静态图没有分状态动图，src 由 mountPetImg 决定
  }

  /* ---------------- 分享页自动起播 ---------------- */

  function autoPlayOnShare() {
    if (!IS_SHARE) return;
    var done = false;
    var tries = 0;
    var timer = null;
    function stop() {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
    }
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (t) {
      document.addEventListener(t, stop, true);
    });
    timer = setInterval(function () {
      if (done) return;
      var a = audioEl();
      if (!a) {
        if (++tries > 40) stop();
        return;
      }
      if (!a.paused) return stop();
      var p;
      try {
        p = a.play();
      } catch (e) {
        return stop();
      }
      if (p && typeof p.then === 'function') {
        p.then(stop, function () {
          if (++tries > 3) stop();
        });
      } else stop();
    }, 400);
  }

  /* ---------------- 启动 ---------------- */

  /**
   * 主题跟 tree2 站内的亮/暗开关走：读同一个 localStorage（tree2.pref.theme），
   * 不看系统偏好。站里切换时这里靠 storage 事件实时跟上。
   */
  function applyTheme() {
    var dark = false;
    try {
      dark = JSON.parse(localStorage.getItem('tree2.pref') || '{}').theme === 'dark';
    } catch (e) {}
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function boot() {
    applyTheme();
    mountBack();
    integrateSkip();
    mountToolsRow();
    mountPet();
    autoPlayOnShare();
    paint();
    volValue = readVol();
    // 探测结构：播放条通常是异步渲染的，2s / 6s 各看一次
    setTimeout(probe, 2000);
    setTimeout(probe, 6000);
    window.addEventListener('resize', placeClose);
    // 兜底轮询：Navi 的播放条可能晚于脚本渲染，宠物/黑胶也可能被 React 重渲染冲掉
    setInterval(function () {
      mountBack();
      integrateSkip();
      mountToolsRow();
      mountPet();
      paint();
      // Howler 换曲时会重置元素音量，这里持续把用户设定的音量压回去
      var a = audioEl();
      if (a && Math.abs((a.volume || 0) - volValue) > 0.02) {
        try {
          a.volume = volValue;
        } catch (e) {}
      }
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') seek(-STEP);
    if (e.key === 'ArrowRight') seek(STEP);
  });

  // 站内点了亮/暗切换，这边实时跟（同源共享 localStorage，storage 事件即通知）
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key === 'tree2.pref') applyTheme();
  });

  // 调试口：控制台执行 window.__t2Debug()
  window.__t2Debug = function () {
    var a = audioEl();
    var prev = findControl('prev');
    var next = findControl('next');
    var play = findControl('play');
    return {
      path: location.pathname,
      hasAudio: !!a,
      paused: a ? a.paused : null,
      currentTime: a ? a.currentTime : null,
      playingFlag: playing,
      isPlaying: isPlaying(),
      pet: !!pet,
      petOff: petOff(),
      skipInline: !!document.querySelector('.t2-nd-skip'),
      backBtn: !!document.querySelector('.t2-nd-back'),
      foundPrev: prev ? prev.tagName + '.' + String(prev.className).slice(0, 30) : null,
      foundNext: next ? next.tagName + '.' + String(next.className).slice(0, 30) : null,
      foundPlay: play ? play.tagName + '.' + String(play.className).slice(0, 30) : null,
    };
  };
})();
