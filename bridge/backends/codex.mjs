// Codex 后端 — 走本机已登录 ChatGPT 的 codex CLI，消耗订阅额度，不额外付费。
//
// 实测（gpt-5.4-mini，关 skills）：约 40s，input ~17k tokens。
// codex exec --json 只发 thread.started / turn.started / item.completed / turn.completed，
// 没有 token 级增量 —— 所以这个后端没有流式，只能靠 status 心跳报时间。
//
// 权威结果来源是 --output-last-message 落盘的文件，不是 JSONL 流。
// JSONL 的事件名是 codex 内部格式，可能随版本变；解析失败也不影响出结果。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_ROOT = path.join(os.tmpdir(), 'duqutishici');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

function stripFences(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

/** 从一坨文本里尽力抠出第一个完整 JSON 对象 */
function extractJson(text) {
  const s = stripFences(text);
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试 */
  }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function runCodex(ctx, conf) {
  await fsp.mkdir(TMP_ROOT, { recursive: true });

  const id = crypto.randomBytes(8).toString('hex');
  const ext = EXT_BY_MIME[ctx.mime] || 'jpg';
  const imgPath = path.join(TMP_ROOT, `${id}.${ext}`);
  const outPath = path.join(TMP_ROOT, `${id}.out.json`);
  const schemaPath = path.join(TMP_ROOT, 'schema.json');
  const workDir = path.join(TMP_ROOT, 'work');

  await fsp.mkdir(workDir, { recursive: true });
  await fsp.writeFile(imgPath, Buffer.from(ctx.imageBase64, 'base64'));
  await fsp.writeFile(schemaPath, JSON.stringify(ctx.schema), 'utf8');

  const args = [
    'exec',
    '-i', imgPath,
    '--skip-git-repo-check',       // 工作目录不是 git 仓库
    '--ephemeral',                 // 别每次悬浮都往磁盘堆 session
    '--ignore-user-config',        // 绕开用户的 gpt-5.6-sol + high effort + 十几个 plugin（auth 仍走 CODEX_HOME）
    '-s', 'read-only',             // 模型不该动任何文件
    '-C', workDir,
    '--output-schema', schemaPath,
    '-o', outPath,
    '--json',
    '-c', `model_reasoning_effort=${conf.reasoningEffort || 'low'}`,
  ];
  for (const f of conf.disableFeatures || []) args.push('--disable', f);
  if (conf.model) args.push('-m', conf.model);
  args.push('-');                  // prompt 走 stdin

  const child = spawn(conf.bin, args, { windowsHide: true });

  let stdoutBuf = '';
  let stderrTail = '';
  let usage = null;
  let agentText = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* noop */ }
  }, ctx.timeoutMs);

  child.stdin.on('error', () => { /* 进程提前挂了 */ });
  child.stdin.end(ctx.prompt, 'utf8');

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;                  // 非 JSONL 行，忽略
      }
      switch (ev.type) {
        case 'turn.started':
          ctx.onStatus?.('thinking');
          break;
        case 'item.completed':
          if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
            agentText = ev.item.text;
          } else if (ev.item?.type === 'error') {
            // codex 自己的提示（如 skills 上下文预算），不是失败
            console.warn(`[codex note] ${String(ev.item.message || '').slice(0, 120)}`);
          }
          break;
        case 'turn.completed':
          usage = ev.usage || null;
          break;
        default:
          break;
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });

  const code = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(wrap(e.message, `找不到 codex：${conf.bin}。改 config.json 的 codex.bin。`)));
    child.on('close', resolve);
  }).finally(() => clearTimeout(timer));

  // 权威结果：-o 落盘的文件
  let data = null;
  if (fs.existsSync(outPath)) {
    try {
      data = extractJson(await fsp.readFile(outPath, 'utf8'));
    } catch {
      /* 落到 agentText */
    }
  }
  if (!data && agentText) data = extractJson(agentText);

  cleanup([imgPath, outPath]);

  if (timedOut) {
    throw wrap(`codex 超时（${Math.round(ctx.timeoutMs / 1000)}s）`, '调大 config.json 的 timeoutMs，或换更快的 codex.model。');
  }
  if (!data) {
    const why = stderrTail.split('\n').filter(Boolean).pop() || `exit=${code}`;
    throw wrap(`codex 没有返回可解析的 JSON（${why}）`, '手动跑一次 codex login status 看登录是否还有效。');
  }

  const missing = (ctx.schema.required || []).filter((k) => !(k in data));
  if (missing.length) {
    throw wrap(`返回缺字段：${missing.join(', ')}`, '模型没按 schema 输出，重试一次通常就好。');
  }

  return { data, model: conf.model || '(codex default)', usage };
}

function wrap(message, hint) {
  const e = new Error(message);
  e.hint = hint;
  return e;
}

function cleanup(files) {
  for (const f of files) fsp.rm(f, { force: true }).catch(() => {});
}
