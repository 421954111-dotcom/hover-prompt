const $list = document.getElementById('list');
const $q = document.getElementById('q');

let history = [];

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function render() {
  const q = $q.value.trim().toLowerCase();
  const rows = q
    ? history.filter(
        (h) =>
          h.head.toLowerCase().includes(q) ||
          (h.tags || []).some((t) => t.toLowerCase().includes(q)) ||
          (h.title || '').toLowerCase().includes(q),
      )
    : history;

  if (!rows.length) {
    $list.innerHTML = `<div class="empty">${history.length ? '没有匹配的记录' : '还没有记录。<br>去任意网页悬浮到图片上试试。'}</div>`;
    return;
  }

  $list.innerHTML = '';
  for (const h of rows) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <img src="${h.thumb || ''}" alt="">
      <div class="c">
        <div class="h"></div>
        <div class="s"></div>
      </div>`;
    el.querySelector('.h').textContent = h.head;
    el.querySelector('.s').textContent = `${ago(h.ts)} · ${safeHost(h.pageUrl)}`;
    el.onclick = async () => {
      const got = await chrome.storage.local.get(`c:${h.hash}`);
      const text = got[`c:${h.hash}`]?.data?.prompt_en || h.head;
      await navigator.clipboard.writeText(text);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 700);
    };
    $list.appendChild(el);
  }
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

// ----------------------------------------------------------- 诊断条 ---
//
// "悬浮没反应" 的排查全在这儿，一眼看出卡在哪一环。

const RESTRICTED = /^(edge|chrome|about|devtools|view-source|chrome-extension|microsoftedge):/;

function setDiag(level, msg, fix) {
  const el = document.getElementById('diag');
  el.className = `diag ${level}`;
  el.innerHTML = msg + (fix ? `<span class="fix">${fix}</span>` : '');
}

async function diagnose() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setDiag('bad', '拿不到当前标签页');

  if (RESTRICTED.test(tab.url || '')) {
    return setDiag('warn', '这类页面浏览器不允许扩展注入', '换一个普通网页再试。');
  }

  let p;
  try {
    p = await chrome.tabs.sendMessage(tab.id, { t: 'ping' });
  } catch {
    return setDiag(
      'bad',
      '这个页面没有加载扩展脚本',
      '装扩展/改代码之前就打开的标签页不会被注入 —— 按 <code>F5</code> 刷新这一页。',
    );
  }
  if (!p?.alive) return setDiag('bad', '扩展脚本无响应', '刷新页面重试。');

  if (!p.enabledHere) {
    return setDiag('warn', `${p.host} 在站点名单里被排除了`, '去设置里改站点名单。');
  }
  const tr = p.triggers || {};
  if (!tr.chip && !tr.altHover && !tr.autoHover) {
    return setDiag('warn', '所有悬浮触发方式都关着', '去设置里至少打开一个。');
  }
  if (p.imgBigEnough === 0) {
    return setDiag(
      'warn',
      `这一页没有 ≥${p.minSize}px 的图片（共扫到 ${p.imgTotal} 个图元素）`,
      p.imgTotal > 0 ? '图都太小被忽略了，可在设置里调低尺寸阈值。' : 'CSS 背景图要悬浮到那个容器上。',
    );
  }
  if (!p.hasToken) {
    return setDiag('warn', '还没配置桥接 Token', '悬浮能出芯片，但点了会报错。去设置里填。');
  }

  const h = await chrome.runtime.sendMessage({ t: 'health' });
  if (!h?.ok) {
    return setDiag(
      'bad',
      h?.status === 401 ? 'Token 不对' : h?.status === 403 ? '桥接拒绝了这个扩展 ID' : '连不上桥接服务',
      h?.status ? '去设置里核对。' : '双击 <code>bridge\\start-bridge.cmd</code> 起服务。',
    );
  }

  const b = h.body || {};
  setDiag(
    'ok',
    `就绪 · 这一页 ${p.imgBigEnough} 张可用图 · ${b.backend}/${b.backend === 'openai' ? b.openaiModel : b.codexModel}`,
    p.settingsSource !== 'sw' ? `注意：设置读的是兜底值（${p.settingsSource}），刷新页面可恢复。` : '',
  );
}

document.getElementById('opt').onclick = () => chrome.runtime.openOptionsPage();
$q.addEventListener('input', render);
diagnose().catch((e) => setDiag('bad', '诊断失败', e.message));

chrome.storage.local.get('history').then((g) => {
  history = g.history || [];
  render();
});
