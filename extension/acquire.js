// 取图阶梯 —— 网页上的图有一半拿不到干净字节，所以按序降级。
//
// 平台调用全部走 io 注入，这样这段分支密集的逻辑可以脱离扩展运行时测试。
// background.js 负责提供 chrome 口味的 io。
//
//   1. data: / blob: / 干净 canvas   content script 已经把字节拿到了
//   2. SW fetch                      host_permissions 给了跨域豁免，带 cookie，能拿下防盗链图床
//   3. 回头让页面 canvas 画一次       SW fetch 失败时（图有 CORS 头就能成）
//   4. captureVisibleTab + 裁切       兜住 canvas 污染 / CSS 背景图 / 精灵图

import { normalize, dataUrlToBlob } from './imaging.js';

const CAPTURE_SETTLE_MS = 60;      // 等一帧，让我们自己的 UI 先藏起来

/**
 * @param req  { source, rect, dpr, isTopFrame }
 * @param io   { fetchUrl(url)→Response, askPage(msg)→reply, captureTab()→dataURL }
 */
const DRM_HINT = '视频画面抓不出来（截屏也是黑的），基本可以确定是 DRM 保护内容。';

export async function acquireImage(req, io) {
  const { source, rect, dpr, isTopFrame } = req;
  const trail = [];

  // 1. content script 已经拿到字节
  if (source.dataUrl) {
    trail.push(source.kind);
    try {
      return { ...(await normalize(dataUrlToBlob(source.dataUrl))), trail };
    } catch (e) {
      trail.push(`${source.kind}:解码失败`);
    }
  }

  if (source.url) {
    // 2. SW 直接 fetch
    trail.push('sw-fetch');
    try {
      const res = await io.fetchUrl(source.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // 只拦明显不是图的：空响应、以及被当成图片链接的 HTML 错误页。
      // 不按 image/* 白名单拦——不少 CDN 把图发成 application/octet-stream。
      // 真不是图的话，下面 normalize 里的 createImageBitmap 会抛。
      if (blob.size === 0) throw new Error('空响应');
      if (/^text\//.test(blob.type)) throw new Error(`返回的是 ${blob.type}`);
      return { ...(await normalize(blob)), trail };
    } catch (e) {
      trail.push(`sw-fetch失败:${e.message}`);
    }

    // 3. 回头让页面用 canvas 画
    trail.push('page-canvas');
    try {
      const r = await io.askPage({ t: 'canvasDraw', url: source.url });
      if (r?.dataUrl) return { ...(await normalize(dataUrlToBlob(r.dataUrl))), trail };
      trail.push(`page-canvas失败:${r?.error || '未知'}`);
    } catch (e) {
      trail.push(`page-canvas失败:${e.message}`);
    }
  }

  // 4. 截屏裁切
  if (!isTopFrame) {
    // 跨域 iframe 拿不到自己在顶层视口里的偏移，硬裁只会裁错位置
    throw new Error(`取图失败（子框架内无法截屏兜底）。尝试路径：${trail.join(' → ')}`);
  }
  trail.push('capture');
  await io.askPage({ t: 'preCapture' }).catch(() => {});
  await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS));
  try {
    const shotUrl = await io.captureTab();
    const out = await normalize(dataUrlToBlob(shotUrl), rect, dpr);
    // 截屏也是一片死黑 → 受保护内容，报清楚点，别把黑图送去跑模型
    if (out.blank && /video/.test(source.kind || '')) {
      const e = new Error('截到的是黑帧');
      e.hint = DRM_HINT;
      throw e;
    }
    return { ...out, trail };
  } catch (e) {
    if (e.hint === DRM_HINT) throw e;
    throw new Error(`取图失败：${e.message}。尝试路径：${trail.join(' → ')}`);
  } finally {
    io.askPage({ t: 'postCapture' }).catch(() => {});
  }
}
