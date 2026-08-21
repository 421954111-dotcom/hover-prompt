// OpenAI API 后端 — 按量付费，但流式、快。
//
// 和 codex 后端共用同一套 SSE 契约，面板代码无需区分。
// 只有 config.json 的 openai.apiKey 非空时，backend:"auto" 才会选它。

const JSON_SCHEMA_NAME = 'image_prompt';

export async function runOpenAI(ctx, conf) {
  if (!conf.apiKey) {
    throw wrap('没有配置 OpenAI API Key', '在 config.json 填 openai.apiKey，或把 backend 改成 "codex"。');
  }

  const body = {
    model: conf.model,
    stream: true,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: ctx.prompt },
          { type: 'input_image', image_url: `data:${ctx.mime};base64,${ctx.imageBase64}` },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: JSON_SCHEMA_NAME,
        schema: ctx.schema,
        strict: true,
      },
    },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ctx.timeoutMs);

  let res;
  try {
    res = await fetch(`${conf.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conf.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw wrap('OpenAI 请求超时', '调大 config.json 的 timeoutMs。');
    throw wrap(`连不上 OpenAI：${e.message}`, '检查网络或代理。');
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    let msg = `OpenAI ${res.status}`;
    let hint = '';
    try {
      const err = JSON.parse(text)?.error;
      if (err?.message) msg = err.message;
      if (err?.code === 'model_not_found' || /does not exist/i.test(msg)) {
        hint = `模型名 "${conf.model}" 不可用。去 platform.openai.com/docs/models 查当前的视觉模型名，填进 config.json 的 openai.model。`;
      } else if (res.status === 401) {
        hint = 'API Key 无效或已撤销。';
      } else if (res.status === 429) {
        hint = '触发限流或余额不足。可临时把 backend 改成 "codex" 走订阅额度。';
      }
    } catch {
      msg += `: ${text.slice(0, 200)}`;
    }
    throw wrap(msg, hint);
  }

  ctx.onStatus?.('thinking');

  let acc = '';
  let usage = null;
  let finalText = '';
  let failure = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }

        switch (ev.type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string') {
              acc += ev.delta;
              ctx.onToken?.(ev.delta);
            }
            break;
          case 'response.output_text.done':
            if (typeof ev.text === 'string') finalText = ev.text;
            break;
          case 'response.completed':
            usage = ev.response?.usage || null;
            if (!finalText) finalText = collectOutputText(ev.response);
            break;
          case 'response.failed':
          case 'response.incomplete':
            failure = ev.response?.error?.message || ev.response?.incomplete_details?.reason || ev.type;
            break;
          case 'error':
            failure = ev.message || ev.error?.message || 'stream error';
            break;
          default:
            break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (failure) throw wrap(`OpenAI 返回失败：${failure}`, '重试一次，或换 backend 到 codex。');

  const text = finalText || acc;
  if (!text.trim()) throw wrap('OpenAI 返回空内容', '重试一次。');

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw wrap(`OpenAI 返回的不是合法 JSON：${e.message}`, '模型没遵守 json_schema，换一个支持结构化输出的模型。');
  }

  const missing = (ctx.schema.required || []).filter((k) => !(k in data));
  if (missing.length) throw wrap(`返回缺字段：${missing.join(', ')}`, '重试一次。');

  return { data, model: conf.model, usage };
}

function collectOutputText(response) {
  const out = [];
  for (const item of response?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') out.push(c.text);
    }
  }
  return out.join('');
}

function wrap(message, hint) {
  const e = new Error(message);
  e.hint = hint;
  return e;
}
