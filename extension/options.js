const $ = (id) => document.getElementById(id);

const FIELDS = {
  bridgeUrl: $('bridgeUrl'),
  token: $('token'),
  minSize: $('minSize'),
  siteMode: $('siteMode'),
  cacheEnabled: $('cacheEnabled'),
};

const TRIGGERS = {
  chip: $('tr-chip'),
  altHover: $('tr-alt'),
  contextMenu: $('tr-menu'),
  autoHover: $('tr-auto'),
};

$('extId').textContent = chrome.runtime.id;

async function load() {
  const s = await chrome.runtime.sendMessage({ t: 'getSettings' });
  FIELDS.bridgeUrl.value = s.bridgeUrl;
  FIELDS.token.value = s.token;
  FIELDS.minSize.value = s.minSize;
  FIELDS.siteMode.value = s.siteMode;
  FIELDS.cacheEnabled.checked = s.cacheEnabled;
  for (const [k, el] of Object.entries(TRIGGERS)) el.checked = Boolean(s.triggers[k]);
  $('siteList').value = (s.siteMode === 'whitelist' ? s.whitelist : s.blacklist).join('\n');
}

function readList() {
  return $('siteList').value.split('\n').map((x) => x.trim()).filter(Boolean);
}

$('siteMode').addEventListener('change', async () => {
  const s = await chrome.runtime.sendMessage({ t: 'getSettings' });
  $('siteList').value = ($('siteMode').value === 'whitelist' ? s.whitelist : s.blacklist).join('\n');
});

$('save').addEventListener('click', async () => {
  const mode = FIELDS.siteMode.value;
  const list = readList();
  const patch = {
    bridgeUrl: FIELDS.bridgeUrl.value.trim() || 'http://127.0.0.1:8712',
    token: FIELDS.token.value.trim(),
    minSize: Math.max(16, Number(FIELDS.minSize.value) || 96),
    siteMode: mode,
    cacheEnabled: FIELDS.cacheEnabled.checked,
    triggers: Object.fromEntries(Object.entries(TRIGGERS).map(([k, el]) => [k, el.checked])),
    [mode === 'whitelist' ? 'whitelist' : 'blacklist']: list,
  };
  await chrome.runtime.sendMessage({ t: 'saveSettings', patch });
  const st = $('saveStatus');
  st.textContent = '已保存';
  st.className = 'status ok';
  setTimeout(() => { st.textContent = ''; }, 1800);
});

$('test').addEventListener('click', async () => {
  const st = $('testStatus');
  st.textContent = '连接中…';
  st.className = 'status';

  // 先把当前填的值存下来，否则测的是旧配置
  await chrome.runtime.sendMessage({
    t: 'saveSettings',
    patch: { bridgeUrl: FIELDS.bridgeUrl.value.trim(), token: FIELDS.token.value.trim() },
  });

  const r = await chrome.runtime.sendMessage({ t: 'health' });
  if (!r.ok) {
    st.className = 'status bad';
    st.textContent =
      r.status === 401 ? 'Token 不对' :
      r.status === 403 ? '来源被拒（检查 allowedExtensionIds）' :
      r.status === 0 ? '连不上 — 桥接没在跑？' : `失败 ${r.status}`;
    return;
  }
  const b = r.body || {};
  st.className = 'status ok';
  st.textContent = `已连接 · ${b.backend} / ${b.backend === 'openai' ? b.openaiModel : b.codexModel}` +
    (b.backend === 'codex' ? (b.codexLoggedIn ? ' · ChatGPT 已登录' : ' · ⚠ codex 未登录') : '');
});

$('clear').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ t: 'clearCache' });
  const st = $('clearStatus');
  st.className = 'status ok';
  st.textContent = `清掉 ${r.removed} 条`;
  setTimeout(() => { st.textContent = ''; }, 1800);
});

load();
