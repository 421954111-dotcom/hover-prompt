// 图像管线 —— 与扩展 API 无关，可在任意页面/worker 里独立引入测试。
// 出口只有一个：把任意来源的图变成「≤MAX_EDGE 的 JPEG + 缩略图 + 内容哈希」。

export const MAX_EDGE = 1024;
export const JPEG_QUALITY = 0.85;
export const THUMB_EDGE = 96;

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 画面是不是一片死板颜色（全黑/全白/纯色）。
 * DRM 视频不会抛异常，它就是安安静静画出一张黑图 —— 不拦住的话会白跑 40 秒。
 * 采 8x8 网格，看三通道各自的极差。
 */
export function isBlank(ctx, w, h, tolerance = 8) {
  const N = 8;
  let min = [255, 255, 255];
  let max = [0, 0, 0];
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = Math.min(w - 1, Math.floor(((ix + 0.5) / N) * w));
      const y = Math.min(h - 1, Math.floor(((iy + 0.5) / N) * h));
      const p = ctx.getImageData(x, y, 1, 1).data;
      for (let c = 0; c < 3; c++) {
        if (p[c] < min[c]) min[c] = p[c];
        if (p[c] > max[c]) max[c] = p[c];
      }
    }
  }
  return max.every((v, c) => v - min[c] < tolerance);
}

/**
 * @param blob      源图
 * @param cropRect  可选，CSS 像素的裁切框（截屏兜底时用）
 * @param dpr       cropRect 是 CSS 像素，截图是物理像素，靠这个换算
 */
export async function normalize(blob, cropRect = null, dpr = 1) {
  const bmp = await createImageBitmap(blob);
  try {
    let sx = 0;
    let sy = 0;
    let sw = bmp.width;
    let sh = bmp.height;

    if (cropRect) {
      sx = Math.max(0, Math.round(cropRect.x * dpr));
      sy = Math.max(0, Math.round(cropRect.y * dpr));
      sw = Math.min(bmp.width - sx, Math.round(cropRect.width * dpr));
      sh = Math.min(bmp.height - sy, Math.round(cropRect.height * dpr));
      if (sw <= 0 || sh <= 0) throw new Error('裁切区域超出截图范围');
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';                 // 铺白底，免得 PNG 透明区在 JPEG 里变黑
    ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });

    const ts = Math.min(1, THUMB_EDGE / Math.max(dw, dh));
    const tw = Math.max(1, Math.round(dw * ts));
    const th = Math.max(1, Math.round(dh * ts));
    const tc = new OffscreenCanvas(tw, th);
    tc.getContext('2d').drawImage(canvas, 0, 0, tw, th);
    const thumbBlob = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.6 });

    const arr = await out.arrayBuffer();
    return {
      base64: bufToBase64(arr),
      mime: 'image/jpeg',
      w: dw,
      h: dh,
      bytes: arr.byteLength,
      blank: isBlank(ctx, dw, dh),
      hash: await sha256Hex(arr),
      thumb: `data:image/jpeg;base64,${bufToBase64(await thumbBlob.arrayBuffer())}`,
    };
  } finally {
    bmp.close();
  }
}
