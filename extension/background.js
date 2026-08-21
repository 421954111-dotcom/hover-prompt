// 读取提示词 — service worker
//
// 职责：取图 → 降采样 → 哈希 → 查缓存 → 调桥接 → 把 SSE 流回吐给 content script。
//
// 取图是这个扩展最脏的部分。六级降级阶梯见 acquireImage()。

import { acquireImage } from './acquire.js';

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8712',
  token: '',
  triggers: { chip: true, altHover: false, contextMenu: false, autoHover: false },
  minSize: 96,
  siteMode: 'blacklist',
  blacklist: [],
  whitelist: [],
  cacheEnabled: true,
};

const CACHE_MAX = 300;
const HISTORY_MAX = 50;

// ---------------------------------------------------------------- 设置 ---

export async function getSettings() {
  const got = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(got.settings || {}), triggers: { ...DEFAULTS.triggers, ...(got.settings?.triggers || {}) } };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ------------------------------------------------------------ 取图阶梯 ---
//
// 1. data:            content script 直接给了
// 阶梯本体在 acquire.js（分支多，抽出去才测得到）。这里只提供 chrome 口味的 io。

function chromeIO(sender) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const windowId = sender.tab?.windowId;
  return {
    fetchUrl: (url) => fetch(url, { credentials: 'include', cache: 'force-cache' }),
    askPage: (msg) => chrome.tabs.sendMessage(tabId, msg, { frameId }),
    captureTab: () => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
  };
}

// ---------------------------------------------------------------- 缓存 ---

async function cacheGet(hash) {
  const k = `c:${hash}`;
  const got = await chrome.storage.local.get(k);
  return got[k] || null;
}

async function cachePut(hash, data, entry) {
  const idxGot = await chrome.storage.local.get('cacheIndex');
  let idx = idxGot.cacheIndex || [];
  idx = idx.filter((h) => h !== hash);
  idx.unshift(hash);

  const evicted = idx.slice(CACHE_MAX);
  idx = idx.slice(0, CACHE_MAX);

  await chrome.storage.local.set({ [`c:${hash}`]: { data, ts: Date.now() }, cacheIndex: idx });
  if (evicted.length) await chrome.storage.local.remove(evicted.map((h) => `c:${h}`));

  const hGot = await chrome.storage.local.get('history');
  const history = (hGot.history || []).filter((x) => x.hash !== hash);
  history.unshift({
    hash,
    thumb: entry.thumb,
    title: entry.title || '',
    pageUrl: entry.pageUrl || '',
    head: String(data.prompt_en || '').slice(0, 160),
    tags: data.tags || [],
    ts: Date.now(),
  });
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// ------------------------------------------------------------ 桥接调用 ---

async function callBridge(settings, payload, onEvent, signal) {
  let res;
  try {
    res = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('已取消');
    const err = new Error('连不上本地桥接服务');
    err.hint = 'bridge';
    throw err;
  }

  if (res.status === 401) {
    const e = new Error('Token 不对');
    e.hint = 'token-bad';
    throw e;
  }
  if (res.status === 403) {
    const e = new Error('桥接拒绝了这个来源');
    e.hint = 'origin';
    throw e;
  }
  if (!res.ok) throw new Error(`桥接返回 ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ev = null;
  let result = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith('event: ')) {
        ev = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev === 'done') result = data;
        else if (ev === 'error') {
          const e = new Error(data.message);
          e.hint = data.hint;
          throw e;
        } else {
          onEvent(ev, data);
        }
      }
    }
  }

  if (!result) throw new Error('桥接连接中断');
  return result;
}

// ------------------------------------------------------------ 端口协议 ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gen') return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (msg) => {
    if (msg.t !== 'gen') return;
    const settings = await getSettings();

    const post = (t, d) => {
      try { port.postMessage({ t, ...d }); } catch { /* 端口没了 */ }
    };

    try {
      if (!settings.token) {
        const e = new Error('还没配置 Token');
        e.hint = 'token-missing';
        throw e;
      }

      post('status', { phase: 'grabbing' });
      const img = await acquireImage(msg, chromeIO(port.sender));
      post('status', { phase: 'grabbed', trail: img.trail, w: img.w, h: img.h });

      if (settings.cacheEnabled && !msg.force) {
        const hit = await cacheGet(img.hash);
        if (hit) {
          post('done', { data: hit.data, cached: true, thumb: img.thumb });
          return;
        }
      }

      const payload = {
        imageBase64: img.base64,
        mime: img.mime,
        meta: { ...msg.meta, w: img.w, h: img.h },
      };

      const data = await callBridge(settings, payload, (ev, d) => post(ev === 'token' ? 'token' : 'status', d), ac.signal);

      await cachePut(img.hash, data, { thumb: img.thumb, title: msg.meta?.title, pageUrl: msg.meta?.pageUrl });
      post('done', { data, cached: false, thumb: img.thumb });
    } catch (e) {
      if (e.name === 'AbortError' || e.message === '已取消') return;
      post('error', { message: e.message, hint: e.hint || '' });
    }
  });
});

// -------------------------------------------------------------- 右键菜单 ---

async function syncContextMenu() {
  const s = await getSettings();
  await chrome.contextMenus.removeAll();
  if (s.triggers.contextMenu) {
    chrome.contextMenus.create({
      id: 'duqu-gen',
      title: '生成提示词',
      contexts: ['image'],
    });
  }
}

chrome.runtime.onInstalled.addListener(syncContextMenu);
chrome.runtime.onStartup.addListener(syncContextMenu);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'duqu-gen') return;
  chrome.tabs.sendMessage(tab.id, { t: 'contextGen', srcUrl: info.srcUrl }, { frameId: info.frameId ?? 0 })
    .catch(() => {});
});

// ------------------------------------------------------- popup / options ---

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.t === 'getSettings') {
    getSettings().then(reply);
    return true;
  }
  if (msg.t === 'saveSettings') {
    saveSettings(msg.patch).then(reply);
    return true;
  }
  if (msg.t === 'health') {
    (async () => {
      const s = await getSettings();
      try {
        const res = await fetch(`${s.bridgeUrl.replace(/\/$/, '')}/health`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        reply({ ok: res.ok, status: res.status, body: await res.json().catch(() => null) });
      } catch (e) {
        reply({ ok: false, status: 0, error: e.message });
      }
    })();
    return true;
  }
  if (msg.t === 'openOptions') {
    chrome.runtime.openOptionsPage();
    reply({ ok: true });
    return false;
  }
  if (msg.t === 'clearCache') {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
      await chrome.storage.local.remove([...keys, 'cacheIndex']);
      reply({ removed: keys.length });
    })();
    return true;
  }
  return false;
});
