// 读取提示词 — content script
//
// 悬浮探测 → 芯片 → 面板。所有 UI 关在 closed shadow DOM 里，
// 页面 CSS 打不进来，我们的样式也漏不出去。

(() => {
  if (window.__duquLoaded) return;
  window.__duquLoaded = true;

  const HOVER_DELAY = 400;
  const IS_TOP = window.top === window;

  // service worker 没醒/报错时的兜底，必须和 background.js 的 DEFAULTS 保持一致。
  // 没有它的话，首次 getSettings 失败会让整个页面永久哑掉直到刷新。
  const FALLBACK = {
    bridgeUrl: 'http://127.0.0.1:8712',
    token: '',
    triggers: { chip: true, altHover: false, contextMenu: false, autoHover: false },
    minSize: 96,
    siteMode: 'blacklist',
    blacklist: [],
    whitelist: [],
    cacheEnabled: true,
  };

  let settings = null;
  let enabledHere = true;
  let settingsSource = 'pending';
  let loading = null;

  // ------------------------------------------------------------ 设置 ---

  function loadSettings() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const got = await chrome.runtime.sendMessage({ t: 'getSettings' });
        settings = got || FALLBACK;
        settingsSource = got ? 'sw' : 'fallback';
      } catch (e) {
        settings = FALLBACK;
        settingsSource = `fallback (${e.message})`;
      }
      const host = location.hostname;
      const inList = (l) => (l || []).some((p) => p && (host === p || host.endsWith('.' + p)));
      enabledHere =
        settings.siteMode === 'whitelist' ? inList(settings.whitelist) : !inList(settings.blacklist);
      loading = null;
      return settings;
    })();
    return loading;
  }

  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) loadSettings();
  });

  // -------------------------------------------------------- Shadow UI ---

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }
  .chip, .panel {
    position: fixed;
    font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #e8e8ea;
    z-index: 2147483647;
  }
  .chip {
    display: none; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: 999px;
    background: rgba(24,24,27,.92); border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 4px 14px rgba(0,0,0,.32);
    cursor: pointer; user-select: none; white-space: nowrap;
    backdrop-filter: blur(8px); font-size: 12px;
    transition: transform .12s ease, background .12s ease;
  }
  .chip:hover { background: rgba(39,39,42,.96); transform: translateY(-1px); }
  .chip.on { display: inline-flex; }

  .panel {
    display: none; width: 380px; max-width: calc(100vw - 24px);
    background: rgba(20,20,23,.97); border: 1px solid rgba(255,255,255,.12);
    border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
    overflow: hidden; backdrop-filter: blur(12px);
  }
  .panel.on { display: block; }

  .hd { display:flex; align-items:center; gap:8px; padding:9px 10px;
        border-bottom:1px solid rgba(255,255,255,.08); cursor:move; }
  .hd img { width:26px; height:26px; border-radius:5px; object-fit:cover; flex:none;
            background:rgba(255,255,255,.06); }
  .hd .ttl { flex:1; min-width:0; font-size:12px; color:#a1a1aa;
             overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hd button { flex:none; width:24px; height:24px; padding:0; border:0; border-radius:6px;
               background:transparent; color:#a1a1aa; cursor:pointer; font-size:14px; line-height:1; }
  .hd button:hover { background:rgba(255,255,255,.09); color:#e8e8ea; }
  .hd button.act { color:#fbbf24; }

  .tabs { display:flex; gap:2px; padding:6px 8px 0; border-bottom:1px solid rgba(255,255,255,.08); }
  .tabs button { flex:none; padding:5px 9px; border:0; background:transparent; cursor:pointer;
                 color:#71717a; font-size:12px; border-radius:6px 6px 0 0; }
  .tabs button:hover { color:#d4d4d8; }
  .tabs button.on { color:#e8e8ea; background:rgba(255,255,255,.08); }

  .body { padding:10px; max-height:340px; overflow-y:auto; overflow-x:hidden; }
  .body::-webkit-scrollbar { width:8px; }
  .body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.14); border-radius:4px; }

  .txt { white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.65; color:#d4d4d8; }
  .txt.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size:11.5px; }

  .kv { display:grid; grid-template-columns:64px 1fr; gap:6px 10px; }
  .kv dt { color:#71717a; font-size:11.5px; text-align:right; padding-top:1px; }
  .kv dd { margin:0; font-size:12.5px; color:#d4d4d8; line-height:1.55; word-break:break-word; }

  .tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:10px;
          padding-top:9px; border-top:1px solid rgba(255,255,255,.07); }
  .tags span { padding:2px 7px; border-radius:999px; font-size:11px;
               background:rgba(255,255,255,.07); color:#a1a1aa; }

  .sec { margin-bottom:12px; }
  .sec:last-child { margin-bottom:0; }
  .sec h4 { margin:0 0 5px; font-size:11px; font-weight:600; color:#71717a;
            text-transform:uppercase; letter-spacing:.05em; }

  .ft { display:flex; align-items:center; gap:8px; padding:8px 10px;
        border-top:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.02); }
  .ft .meta { flex:1; min-width:0; font-size:11px; color:#71717a;
              overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ft button { flex:none; padding:5px 11px; border:1px solid rgba(255,255,255,.14);
               border-radius:7px; background:rgba(255,255,255,.06); color:#e8e8ea;
               font-size:12px; cursor:pointer; }
  .ft button:hover { background:rgba(255,255,255,.12); }
  .ft button.ok { background:rgba(34,197,94,.22); border-color:rgba(34,197,94,.45); color:#86efac; }

  .load { display:flex; flex-direction:column; gap:7px; align-items:center;
          padding:22px 12px; text-align:center; }
  .spin { width:20px; height:20px; border:2px solid rgba(255,255,255,.14);
          border-top-color:#a1a1aa; border-radius:50%; animation:sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .load .t1 { font-size:12.5px; color:#d4d4d8; }
  .load .t2 { font-size:11px; color:#71717a; }
  .prev { width:100%; margin-top:6px; padding:8px; border-radius:7px;
          background:rgba(255,255,255,.04); font-size:11.5px; line-height:1.6;
          color:#a1a1aa; text-align:left; white-space:pre-wrap; word-break:break-word;
          max-height:120px; overflow:hidden; }

  .err { padding:14px 12px; }
  .err .m { font-size:12.5px; color:#fca5a5; margin-bottom:6px; }
  .err .h { font-size:11.5px; color:#a1a1aa; line-height:1.6; }
  .err code { display:block; margin-top:7px; padding:7px 9px; border-radius:6px;
              background:rgba(0,0,0,.4); font-family:ui-monospace,Consolas,monospace;
              font-size:11px; color:#d4d4d8; user-select:all; word-break:break-all; }
</style>
<div class="chip" part="chip"><span>&#9889;</span><span class="chiptext">提示词</span></div>
<div class="panel">
  <div class="hd">
    <img class="thumb" alt="">
    <div class="ttl"></div>
    <button class="pin" title="钉住">&#128204;</button>
    <button class="close" title="关闭">&#10005;</button>
  </div>
  <div class="tabs"></div>
  <div class="body"></div>
  <div class="ft"><div class="meta"></div><button class="copy">复制</button></div>
</div>`;

  const $chip = root.querySelector('.chip');
  const $chipText = root.querySelector('.chiptext');
  const $panel = root.querySelector('.panel');
  const $hd = root.querySelector('.hd');
  const $thumb = root.querySelector('.thumb');
  const $ttl = root.querySelector('.ttl');
  const $pin = root.querySelector('.pin');
  const $close = root.querySelector('.close');
  const $tabs = root.querySelector('.tabs');
  const $body = root.querySelector('.body');
  const $meta = root.querySelector('.meta');
  const $copy = root.querySelector('.copy');

  (document.body || document.documentElement).appendChild(host);

  // ------------------------------------------------------------ 状态 ---

  const ui = {
    target: null,       // 当前锚定的元素
    anchorRect: null,
    pinned: false,
    dragged: null,      // {x,y} 拖过之后就不再跟随滚动
    data: null,
    tab: 'main',
    port: null,
    hoverTimer: null,
    streamBuf: '',
  };

  // -------------------------------------------------------- 目标判定 ---

  function bgUrlOf(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return null;
    const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
    const u = m?.[2];
    if (!u || u.startsWith('#')) return null;
    return u;
  }

  function resolveTarget(el) {
    if (!el || el === host || host.contains(el)) return null;
    const direct = el.closest?.('img, canvas, video');
    if (direct) return direct;
    let cur = el;
    for (let i = 0; i < 3 && cur && cur.nodeType === 1; i++, cur = cur.parentElement) {
      if (bgUrlOf(cur)) return cur;
    }
    return null;
  }

  function bigEnough(el) {
    const r = el.getBoundingClientRect();
    const min = settings?.minSize ?? 96;
    return r.width >= min && r.height >= min;
  }

  // ------------------------------------------------------------ 定位 ---

  // 芯片钉在图片中心，不跟光标 —— 跟随的版本永远在指针前面跑，点不到。
  function placeChip() {
    if (!$chip.classList.contains('on') || !ui.anchorRect) return;
    const r = ui.anchorRect;
    const vw = innerWidth;
    const vh = innerHeight;
    const cw = $chip.offsetWidth || 84;
    const ch = $chip.offsetHeight || 28;
    // 取图片与视口的可见交集求中心：超长图的几何中心可能在屏幕外，芯片就够不着了
    const cx = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2;
    const cy = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
    $chip.style.left = `${Math.max(8, Math.min(cx - cw / 2, vw - cw - 8))}px`;
    $chip.style.top = `${Math.max(8, Math.min(cy - ch / 2, vh - ch - 8))}px`;
  }

  function placePanel() {
    if (!$panel.classList.contains('on') || !ui.anchorRect) return;
    const r = ui.anchorRect;
    const vw = innerWidth;
    const vh = innerHeight;
    const pw = $panel.offsetWidth || 380;
    const ph = $panel.offsetHeight || 240;
    if (ui.dragged) {
      $panel.style.left = `${Math.max(8, Math.min(ui.dragged.x, vw - pw - 8))}px`;
      $panel.style.top = `${Math.max(8, Math.min(ui.dragged.y, vh - ph - 8))}px`;
      return;
    }
    let x = r.right + 10;
    if (x + pw > vw - 8) x = r.left - pw - 10;      // 右边放不下 → 翻到左边
    if (x < 8) x = Math.min(Math.max(8, r.left), vw - pw - 8);   // 两边都放不下 → 压在图上
    let y = r.top;
    if (y + ph > vh - 8) y = vh - ph - 8;
    $panel.style.left = `${Math.max(8, x)}px`;
    $panel.style.top = `${Math.max(8, y)}px`;
  }

  function place() {
    placeChip();
    placePanel();
  }

  let rafPending = false;
  function schedulePlace() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (ui.target?.isConnected) ui.anchorRect = ui.target.getBoundingClientRect();
      place();
    });
  }
  addEventListener('scroll', schedulePlace, { passive: true, capture: true });
  addEventListener('resize', schedulePlace, { passive: true });

  // ------------------------------------------------------------ 悬浮 ---

  function showChip(el) {
    ui.target = el;
    ui.anchorRect = el.getBoundingClientRect();
    $chipText.textContent = '提示词';
    $chip.classList.add('on');
    placeChip();
  }

  function hideChip() {
    $chip.classList.remove('on');
    if (!$panel.classList.contains('on')) ui.target = null;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!settings) {
        loadSettings();          // 首次拿设置失败过，下次悬浮再试，别一直哑着
        return;
      }
      if (!enabledHere) return;
      if (!settings.triggers.chip && !settings.triggers.altHover && !settings.triggers.autoHover) return;
      if (host.contains(e.target)) return;

      const el = resolveTarget(e.target);
      clearTimeout(ui.hoverTimer);

      if (!el || !bigEnough(el)) {
        if (!$panel.classList.contains('on')) hideChip();
        return;
      }
      if (el === ui.target && $chip.classList.contains('on')) return;

      const instant = settings.triggers.altHover && e.altKey;
      ui.hoverTimer = setTimeout(
        () => {
          if (instant || settings.triggers.autoHover) {
            ui.target = el;
            ui.anchorRect = el.getBoundingClientRect();
            start(el);
          } else if (settings.triggers.chip) {
            showChip(el);
          }
        },
        instant ? 0 : HOVER_DELAY,
      );
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      if (host.contains(e.relatedTarget)) return;
      const el = resolveTarget(e.target);
      if (el && el === ui.target && !$panel.classList.contains('on')) {
        clearTimeout(ui.hoverTimer);
        ui.hoverTimer = setTimeout(hideChip, 220);
      }
    },
    true,
  );

  $chip.addEventListener('mouseenter', () => clearTimeout(ui.hoverTimer));

  $chip.addEventListener('mouseleave', (e) => {
    // 离开芯片后没落回那张图上，就收起来。
    // 不能只靠 document 的 mouseout：芯片在 shadow DOM 里，事件会被重定向到宿主，
    // 那边的 resolveTarget 认不出来，芯片会永远挂着。
    const { clientX: x, clientY: y } = e;
    clearTimeout(ui.hoverTimer);
    ui.hoverTimer = setTimeout(() => {
      if (!ui.target || resolveTarget(document.elementFromPoint(x, y)) !== ui.target) hideChip();
    }, 220);
  });
  $chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ui.target) start(ui.target);
  });

  // ---------------------------------------------------------- 取图侧 ---

  function toDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  /** 一张画布是不是一片死板颜色（DRM 视频会安静地画出全黑，不会抛异常） */
  function looksBlank(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const N = 8;
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const x = Math.min(canvas.width - 1, Math.floor(((ix + 0.5) / N) * canvas.width));
        const y = Math.min(canvas.height - 1, Math.floor(((iy + 0.5) / N) * canvas.height));
        const p = ctx.getImageData(x, y, 1, 1).data;
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
    }
    return max.every((v, c) => v - min[c] < 8);
  }

  /** 页面上下文能直接拿到字节的情况：data: / blob: / 未污染的 canvas / 视频当前帧 */
  async function acquireLocal(el) {
    if (el.tagName === 'CANVAS') {
      try {
        return { kind: 'canvas', dataUrl: el.toDataURL('image/png') };
      } catch {
        return { kind: 'tainted-canvas' };          // 交给截屏兜底
      }
    }

    if (el.tagName === 'VIDEO') {
      // 抓当前播放帧。readyState≥2 才有帧可画。
      if (el.readyState >= 2 && el.videoWidth) {
        try {
          const c = document.createElement('canvas');
          c.width = el.videoWidth;
          c.height = el.videoHeight;
          c.getContext('2d', { willReadFrequently: true }).drawImage(el, 0, 0);
          if (!looksBlank(c)) {
            return { kind: 'video-frame', dataUrl: c.toDataURL('image/jpeg', 0.9), t: el.currentTime };
          }
          // 画得出来但一片死黑。多半是 DRM，但也可能是画面还没绘制、标签页在后台之类。
          // 所以不在这儿判死，往下退 poster / 截屏，等截屏也黑了再说。
          if (el.poster) return { kind: 'video-poster', url: new URL(el.poster, location.href).href };
          return { kind: 'blank-video-frame' };
        } catch {
          // 跨域视频没带 CORS 头 → 画布被污染。截屏兜底仍然有戏。
        }
      }
      if (el.poster) return { kind: 'video-poster', url: new URL(el.poster, location.href).href };
      return { kind: 'tainted-video' };
    }

    let url = null;
    if (el.tagName === 'IMG') url = el.currentSrc || el.src;
    else url = bgUrlOf(el);

    if (!url) return { kind: 'none' };
    if (url.startsWith('data:')) return { kind: 'data', dataUrl: url };
    if (url.startsWith('blob:')) {
      // blob URL 绑定 origin，SW 取不到，必须在这儿 fetch
      try {
        const r = await fetch(url);
        return { kind: 'blob', dataUrl: await toDataUrl(await r.blob()) };
      } catch {
        return { kind: 'blob-failed' };
      }
    }
    return { kind: 'url', url: new URL(url, location.href).href };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.t === 'ping') {
      // 供 popup 的诊断条使用：为什么这一页悬浮没反应
      const min = settings?.minSize ?? FALLBACK.minSize;
      const all = [...document.querySelectorAll('img, canvas, video[poster]')];
      const big = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= min && r.height >= min;
      });
      reply({
        alive: true,
        topFrame: IS_TOP,
        host: location.hostname,
        settingsSource,
        enabledHere,
        triggers: settings?.triggers || null,
        hasToken: Boolean(settings?.token),
        minSize: min,
        imgTotal: all.length,
        imgBigEnough: big.length,
      });
      return false;
    }
    if (msg.t === 'canvasDraw') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          reply({ dataUrl: c.toDataURL('image/png') });
        } catch (e) {
          reply({ error: '画布被污染' });
        }
      };
      img.onerror = () => reply({ error: '图片加载失败' });
      img.src = msg.url;
      return true;
    }
    if (msg.t === 'preCapture') {
      host.style.visibility = 'hidden';
      reply({ ok: true });
      return false;
    }
    if (msg.t === 'postCapture') {
      host.style.visibility = '';
      reply({ ok: true });
      return false;
    }
    if (msg.t === 'contextGen') {
      const el = [...document.querySelectorAll('img')].find(
        (i) => i.currentSrc === msg.srcUrl || i.src === msg.srcUrl,
      );
      if (el) {
        ui.target = el;
        ui.anchorRect = el.getBoundingClientRect();
        start(el);
      }
      reply({ ok: Boolean(el) });
      return false;
    }
    return false;
  });

  // ------------------------------------------------------------ 生成 ---

  async function start(el, force = false) {
    hideChip();
    ui.target = el;
    ui.anchorRect = el.getBoundingClientRect();
    ui.data = null;
    ui.streamBuf = '';
    ui.dragged = null;
    openPanel();
    renderLoading(0, '正在取图');

    const source = await acquireLocal(el);
    const r = el.getBoundingClientRect();

    try {
      ui.port?.disconnect();
    } catch { /* noop */ }
    const port = chrome.runtime.connect({ name: 'gen' });
    ui.port = port;

    const t0 = Date.now();
    let lastPhase = '正在取图';

    port.onMessage.addListener((m) => {
      if (m.t === 'status') {
        if (m.phase === 'grabbing') lastPhase = '正在取图';
        else if (m.phase === 'grabbed') lastPhase = `已取图 ${m.w}×${m.h}`;
        else if (m.phase === 'queued') lastPhase = '排队中';
        else if (m.phase === 'starting') lastPhase = '正在启动模型';
        else if (m.phase === 'thinking') lastPhase = '模型分析中';
        renderLoading(Math.round((Date.now() - t0) / 1000), lastPhase);
      } else if (m.t === 'token') {
        ui.streamBuf += m.delta || '';
        renderLoading(Math.round((Date.now() - t0) / 1000), '正在生成', partialField(ui.streamBuf, 'prompt_en')?.text);
      } else if (m.t === 'done') {
        ui.data = m.data;
        if (m.thumb) {
          $thumb.src = m.thumb;
          $thumb.style.display = '';
        }
        renderResult(m.cached, Math.round((Date.now() - t0) / 1000));
      } else if (m.t === 'error') {
        renderError(m.message, m.hint);
      }
    });

    port.postMessage({
      t: 'gen',
      force,
      source,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      dpr: devicePixelRatio || 1,
      isTopFrame: IS_TOP,
      meta: {
        pageUrl: location.href,
        title: document.title,
        alt: el.getAttribute?.('alt') || el.getAttribute?.('title') || '',
        kind: source.kind,
        videoTime: source.t,          // 有值说明是视频帧，提示词模板会带上时间点
      },
    });
  }

  /** 从还没收完的 JSON 里抠出某个字段的当前值，用于流式预览 */
  function partialField(buf, key) {
    const k = `"${key}"`;
    let i = buf.indexOf(k);
    if (i < 0) return null;
    const colon = buf.indexOf(':', i + k.length);
    if (colon < 0) return null;
    const q = buf.indexOf('"', colon);
    if (q < 0) return null;
    let out = '';
    for (let p = q + 1; p < buf.length; p++) {
      const c = buf[p];
      if (c === '\\') {
        const n = buf[p + 1];
        if (n === undefined) break;
        if (n === 'u') {
          out += String.fromCharCode(parseInt(buf.substr(p + 2, 4), 16) || 32);
          p += 5;
        } else {
          out += { n: '\n', t: '\t', r: '' }[n] ?? n;
          p += 1;
        }
        continue;
      }
      if (c === '"') return { text: out, complete: true };
      out += c;
    }
    return { text: out, complete: false };
  }

  // ------------------------------------------------------------ 渲染 ---

  function openPanel() {
    $panel.classList.add('on');
    $ttl.textContent = ui.target?.getAttribute?.('alt') || location.hostname;
    $thumb.removeAttribute('src');
    $thumb.style.display = 'none';        // 没缩略图就别露裂图
    $tabs.innerHTML = '';
    $meta.textContent = '';
    $copy.style.display = 'none';
    place();
  }

  function closePanel() {
    $panel.classList.remove('on');
    ui.pinned = false;
    $pin.classList.remove('act');
    ui.target = null;
    ui.data = null;
    try { ui.port?.disconnect(); } catch { /* noop */ }
    ui.port = null;
  }

  function renderLoading(sec, phase, preview) {
    const slow = sec >= 8;
    $body.innerHTML = `
      <div class="load">
        <div class="spin"></div>
        <div class="t1">${esc(phase)}${sec ? ` · ${sec}s` : ''}</div>
        <div class="t2">${slow ? 'Codex 走订阅额度，通常 40–50 秒' : '&nbsp;'}</div>
        ${preview ? `<div class="prev">${esc(preview)}</div>` : ''}
      </div>`;
    place();
  }

  function renderError(message, hint) {
    const help = {
      bridge: '本地桥接没在跑。在 E:\\读取提示词\\bridge 下双击 start-bridge.cmd，或执行：',
      'token-missing': '打开扩展选项页把 Token 填上 —— 桥接启动时控制台会打印，也可以直接从这里拷：',
      'token-bad': '选项页里的 Token 和 bridge/config.json 对不上，重新拷一遍：',
      origin: '桥接的 allowedExtensionIds 里没有这个扩展 ID。',
    }[hint];
    const code =
      hint === 'bridge' ? 'node E:\\读取提示词\\bridge\\server.mjs'
      : hint === 'token-missing' || hint === 'token-bad' ? 'E:\\读取提示词\\bridge\\config.json'
      : '';
    $body.innerHTML = `
      <div class="err">
        <div class="m">${esc(message)}</div>
        <div class="h">${esc(help || hint || '重试一次通常就好。')}
          ${code ? `<code>${esc(code)}</code>` : ''}
        </div>
      </div>`;
    $tabs.innerHTML = '';
    $copy.style.display = '';
    $copy.classList.remove('ok');
    // 配置类错误直接给"打开设置"，别让人在报错面板前面卡着
    if (hint === 'token-missing' || hint === 'token-bad' || hint === 'origin') {
      $copy.textContent = '打开设置';
      $copy.onclick = () => chrome.runtime.sendMessage({ t: 'openOptions' });
    } else {
      $copy.textContent = '重试';
      $copy.onclick = () => ui.target && start(ui.target, true);
    }
    $meta.textContent = '';
    place();
  }

  const TABS = [
    { id: 'main', label: '主提示词' },
    { id: 'parts', label: '拆解' },
    { id: 'mj', label: 'MJ' },
    { id: 'sd', label: 'SD' },
    { id: 'zh', label: '中文' },
  ];

  function copyTextFor(tab, d) {
    switch (tab) {
      case 'main': return d.prompt_en;
      case 'mj': return `${d.prompt_en} ${d.mj_params}`.trim();
      case 'sd': return d.sd_positive;
      case 'zh': return d.prompt_zh;
      case 'parts':
        return ['subject', 'style', 'composition', 'lighting', 'color', 'medium', 'camera']
          .filter((k) => d[k])
          .map((k) => `${k}: ${d[k]}`)
          .join('\n');
      default: return '';
    }
  }

  function renderResult(cached, sec) {
    const d = ui.data;
    $tabs.innerHTML = '';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.className = t.id === ui.tab ? 'on' : '';
      b.onclick = () => { ui.tab = t.id; renderResult(cached, sec); };
      $tabs.appendChild(b);
    }

    const tagsHtml = d.tags?.length
      ? `<div class="tags">${d.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
      : '';

    if (ui.tab === 'parts') {
      const rows = [
        ['主体', d.subject], ['风格', d.style], ['构图', d.composition],
        ['光线', d.lighting], ['色彩', d.color], ['材质', d.medium], ['镜头', d.camera],
      ].filter(([, v]) => v);
      $body.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${tagsHtml}`;
    } else if (ui.tab === 'mj') {
      $body.innerHTML = `<div class="txt mono">${esc(d.prompt_en)} <b style="color:#fbbf24">${esc(d.mj_params)}</b></div>${tagsHtml}`;
    } else if (ui.tab === 'sd') {
      $body.innerHTML = `
        <div class="sec"><h4>Positive</h4><div class="txt mono">${esc(d.sd_positive)}</div></div>
        <div class="sec"><h4>Negative</h4><div class="txt mono" style="color:#fca5a5">${esc(d.sd_negative)}</div></div>`;
    } else if (ui.tab === 'zh') {
      $body.innerHTML = `<div class="txt">${esc(d.prompt_zh)}</div>${tagsHtml}`;
    } else {
      $body.innerHTML = `<div class="txt">${esc(d.prompt_en)}</div>${tagsHtml}`;
    }

    const m = d._meta || {};
    $meta.textContent = cached
      ? '缓存命中 · 即时'
      : `${m.backend || ''} ${m.model || ''} · ${sec}s`;
    $meta.title = m.usage ? `in ${m.usage.input_tokens} / out ${m.usage.output_tokens} tokens` : '';

    const label = ui.tab === 'sd' ? '复制正向' : '复制';
    $copy.style.display = '';
    $copy.classList.remove('ok');
    $copy.textContent = label;
    $copy.onclick = async () => {
      await copy(copyTextFor(ui.tab, d));
      $copy.textContent = '已复制';
      $copy.classList.add('ok');
      setTimeout(() => { $copy.textContent = label; $copy.classList.remove('ok'); }, 1200);
    };
    place();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------------------------------------------------ 面板交互 ---

  $close.onclick = closePanel;
  $pin.onclick = () => {
    ui.pinned = !ui.pinned;
    $pin.classList.toggle('act', ui.pinned);
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $panel.classList.contains('on')) closePanel();
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!$panel.classList.contains('on') || ui.pinned) return;
      if (!host.contains(e.target)) closePanel();
    },
    true,
  );

  // 拖动
  let drag = null;
  $hd.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const r = $panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    ui.dragged = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    place();
  });
  addEventListener('mouseup', () => { drag = null; });

  loadSettings();
})();
