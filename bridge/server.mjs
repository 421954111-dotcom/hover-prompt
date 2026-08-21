// 读取提示词 — 本地桥接服务
//
// 扩展 → 本服务 → 已登录 ChatGPT 的 Codex CLI（或 OpenAI API）
// 零依赖，只用 node: 内置模块。
//
//   node server.mjs
//
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runCodex } from './backends/codex.mjs';
import { runOpenAI } from './backends/openai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'config.json');
const SCHEMA_PATH = path.join(HERE, 'prompt.schema.json');
const PROMPT_PATH = path.join(HERE, 'prompt.txt');

const MAX_BODY_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------- config ---

const DEFAULTS = {
  port: 8712,
  token: '',                       // 首次运行自动生成
  backend: 'auto',                 // auto | codex | openai
  allowedExtensionIds: [],         // 空数组 = 放行任意 chrome-extension:// 来源（token 仍强制）
  timeoutMs: 150000,
  maxConcurrent: 2,
  codex: {
    bin: '',                       // 空则自动探测
    model: 'gpt-5.4-mini',         // 实测最快且质量够用；换 gpt-5.6-luna / gpt-5.6-sol 更好但更慢
    reasoningEffort: 'low',
    disableFeatures: ['skill_search', 'memories', 'plugins'],
  },
  openai: {
    apiKey: '',                    // 填了才会被 backend:auto 选中
    model: 'gpt-5.4-mini',         // 若报 model_not_found，去 platform.openai.com/docs/models 查当前视觉模型名
    baseUrl: 'https://api.openai.com/v1',
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function resolveCodexBin() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    path.join(os.homedir(), '.codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error(`[config] ${CONFIG_PATH} 解析失败：${e.message}`);
      process.exit(1);
    }
  }
  const cfg = merge(DEFAULTS, user);
  let dirty = !fs.existsSync(CONFIG_PATH);
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    dirty = true;
  }
  if (!cfg.codex.bin) {
    cfg.codex.bin = resolveCodexBin();
    dirty = true;
  }
  if (dirty) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

const cfg = loadConfig();
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf8');

function effectiveBackend() {
  if (cfg.backend === 'openai') return 'openai';
  if (cfg.backend === 'codex') return 'codex';
  return cfg.openai.apiKey ? 'openai' : 'codex';   // auto
}

// ------------------------------------------------------------------ auth ---

function tokenOk(req) {
  const header = req.headers['authorization'] || '';
  const got = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(got);
  const b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 关键防线：任何 http(s) 页面来源一律拒绝。
// 浏览器不允许页面伪造或省略 Origin（no-cors 模式下同样会带），
// 所以这一条挡住了"任意网页 JS 白嫖你的订阅额度"。
// 无 Origin 的请求（curl / 健康检查）放行，但仍需 token。
function originOk(origin) {
  if (!origin) return true;
  if (!origin.startsWith('chrome-extension://')) return false;
  const ids = cfg.allowedExtensionIds;
  if (!ids.length) return true;
  return ids.some((id) => origin === `chrome-extension://${id}`);
}

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(origin),
  });
  res.end(body);
}

// ------------------------------------------------------------------- SSE ---
//
// 统一契约（两个后端必须一致，面板代码与后端无关）：
//   event: status  {"phase":"queued|starting|thinking","elapsedMs":N}
//   event: token   {"delta":"..."}          — 仅 openai 后端有；codex 不吐增量
//   event: done    {...schema 字段, "_meta":{...}}
//   event: error   {"message":"...","hint":"..."}

function openSse(res, origin) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(origin),
  });
  res.write(': open\n\n');
}

// ------------------------------------------------------- single-flight ---
//
// 同一张图并发请求合流到同一次模型调用；后到的客户端先重放已发生的事件。

const inflight = new Map();   // hash -> { events: [[ev,data],...], clients: Set<res>, finished: bool }

let running = 0;
const waiting = [];

function acquireSlot() {
  if (running < cfg.maxConcurrent) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  running--;
  const next = waiting.shift();
  if (next) {
    running++;
    next();
  }
}

function writeEvent(res, ev, data) {
  try {
    res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 客户端已断开 */
  }
}

function broadcast(job, ev, data) {
  job.events.push([ev, data]);
  for (const res of job.clients) writeEvent(res, ev, data);
}

function finish(job, ev, data) {
  broadcast(job, ev, data);
  job.finished = true;
  for (const res of job.clients) {
    try { res.end(); } catch { /* noop */ }
  }
  job.clients.clear();
}

// -------------------------------------------------------------- handler ---

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function buildPrompt(meta = {}) {
  const lines = [
    `  pageUrl: ${meta.pageUrl || '(unknown)'}`,
    `  pageTitle: ${meta.title || '(none)'}`,
    `  imageAlt: ${meta.alt || '(none)'}`,
    `  dimensions: ${meta.w && meta.h ? `${meta.w}x${meta.h}` : '(unknown)'}`,
  ];
  if (typeof meta.videoTime === 'number') {
    // 让模型知道这是动态画面里的一格，别把运动模糊之类当成刻意的风格选择
    lines.push(`  source: a still frame captured from a playing video at ${mmss(meta.videoTime)}`);
  }
  return promptTemplate + lines.join('\n') + '\n';
}

async function handlePrompt(req, res, origin) {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { error: 'invalid_body' }, origin);

  const { imageBase64, mime, meta } = body;
  if (typeof imageBase64 !== 'string' || !imageBase64.length) {
    return sendJson(res, 400, { error: 'missing_image' }, origin);
  }

  const hash = crypto.createHash('sha256').update(imageBase64).digest('hex').slice(0, 32);

  // 已有同图在跑 → 挂上去重放
  const existing = inflight.get(hash);
  if (existing && !existing.finished) {
    openSse(res, origin);
    for (const [ev, data] of existing.events) writeEvent(res, ev, data);
    existing.clients.add(res);
    req.on('close', () => existing.clients.delete(res));
    return;
  }

  const job = { events: [], clients: new Set([res]), finished: false };
  inflight.set(hash, job);
  openSse(res, origin);
  req.on('close', () => job.clients.delete(res));

  const backend = effectiveBackend();
  const startedAt = Date.now();
  broadcast(job, 'status', { phase: 'queued', elapsedMs: 0, backend });

  await acquireSlot();
  if (job.clients.size === 0) {          // 所有客户端都跑了，别浪费额度
    releaseSlot();
    inflight.delete(hash);
    return;
  }

  const heartbeat = setInterval(() => {
    broadcast(job, 'status', { phase: 'thinking', elapsedMs: Date.now() - startedAt, backend });
  }, 2000);

  const ctx = {
    imageBase64,
    mime: mime || 'image/jpeg',
    prompt: buildPrompt(meta),
    schema,
    timeoutMs: cfg.timeoutMs,
    onStatus: (phase) => broadcast(job, 'status', { phase, elapsedMs: Date.now() - startedAt, backend }),
    onToken: (delta) => broadcast(job, 'token', { delta }),
  };

  try {
    broadcast(job, 'status', { phase: 'starting', elapsedMs: Date.now() - startedAt, backend });
    const result =
      backend === 'openai' ? await runOpenAI(ctx, cfg.openai) : await runCodex(ctx, cfg.codex);

    finish(job, 'done', {
      ...result.data,
      _meta: {
        backend,
        model: result.model,
        ms: Date.now() - startedAt,
        usage: result.usage || null,
        hash,
      },
    });
    console.log(`[ok] ${backend}/${result.model} ${Date.now() - startedAt}ms hash=${hash.slice(0, 8)}`);
  } catch (e) {
    console.error(`[err] ${backend}: ${e.message}`);
    finish(job, 'error', { message: e.message, hint: e.hint || '' });
  } finally {
    clearInterval(heartbeat);
    releaseSlot();
    setTimeout(() => inflight.delete(hash), 30000);   // 留一会儿给慢半拍的重连
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// ------------------------------------------------------------------ 路由 ---

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    if (!originOk(origin)) return sendJson(res, 403, { error: 'origin_forbidden' }, '');
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (!originOk(origin)) {
    console.warn(`[deny] origin=${origin} ${req.method} ${url.pathname}`);
    return sendJson(res, 403, { error: 'origin_forbidden' }, '');
  }
  if (!tokenOk(req)) {
    return sendJson(res, 401, { error: 'bad_token' }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const { codexLoggedIn, detail } = await probeCodex();
    return sendJson(
      res,
      200,
      {
        ok: true,
        backend: effectiveBackend(),
        configuredBackend: cfg.backend,
        codexLoggedIn,
        codexDetail: detail,
        codexModel: cfg.codex.model,
        openaiConfigured: Boolean(cfg.openai.apiKey),
        openaiModel: cfg.openai.model,
      },
      origin,
    );
  }

  if (req.method === 'POST' && url.pathname === '/prompt') {
    return handlePrompt(req, res, origin);
  }

  return sendJson(res, 404, { error: 'not_found' }, origin);
});

async function probeCodex() {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cfg.codex.bin, ['login', 'status'], { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve({ codexLoggedIn: false, detail: 'codex 未找到：检查 config.json 的 codex.bin' }));
    p.on('close', () => {
      const text = out.trim();
      resolve({ codexLoggedIn: /Logged in/i.test(text), detail: text.split('\n')[0] || '' });
    });
    setTimeout(() => { try { p.kill(); } catch { /* noop */ } }, 8000);
  });
}

server.listen(cfg.port, '127.0.0.1', () => {
  console.log('读取提示词 · 桥接服务');
  console.log(`  地址    http://127.0.0.1:${cfg.port}`);
  console.log(`  后端    ${effectiveBackend()}${cfg.backend === 'auto' ? ' (auto)' : ''}`);
  console.log(`  模型    ${effectiveBackend() === 'openai' ? cfg.openai.model : cfg.codex.model}`);
  console.log(`  Token   ${cfg.token}`);
  console.log('');
  console.log('  把上面的 Token 粘进扩展选项页。config.json 里可改端口/模型/后端。');
  if (!cfg.allowedExtensionIds.length) {
    console.log('  提示：把扩展 ID 填进 config.json 的 allowedExtensionIds 可再收紧一层。');
  }
});
