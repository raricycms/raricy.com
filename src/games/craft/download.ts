// 手工间成品的导出。全部在浏览器本地完成，不上传任何字节。
// 失败以 false 返回（调用方要给出可见提示）—— 浏览器拒绝下载或画布为空时静默无反应
// 是最难排查的一种「看起来按了」的状态。

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及取走数据，留一拍再释放。
  window.setTimeout(() => URL.revokeObjectURL(url), 8_000);
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(false); return; }
        try { saveBlob(blob, filename); resolve(true); } catch { resolve(false); }
      }, 'image/png');
    } catch { resolve(false); }
  });
}

/**
 * 把一段独立的成品 SVG 栅格化成 PNG。可见的成品图里没有任何交互层与 CSS 依赖，
 * 序列化后交给 <img> 再画进画布；透明背景由 SVG 自己保持。
 */
export async function downloadSvg(svg: SVGSVGElement, width: number, height: number, filename: string): Promise<boolean> {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    const source = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      image.decoding = 'sync';
      const loaded = await new Promise<boolean>((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = url;
      });
      if (!loaded) return false;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return false;
      context.drawImage(image, 0, 0, width, height);
      return await downloadCanvas(canvas, filename);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}
