'use client';

// 二维码识别：拖放 / 选择图片 → canvas → jsQR → 显示解码文本。
//
// 【全部在本地】图片不经过网络：File → ObjectURL → <img> → canvas.getImageData，
// 解码用 jsQR 在浏览器里完成。页面上必须写清这一点（用户对「上传二维码」很敏感）。
//
// 【为什么先等比缩放】手机拍的原图动辄 4000×3000，getImageData 会分配 ~48MB 的
// Uint8ClampedArray；部分低端机直接崩标签页。最长边超过 2000px 先等比缩到 2000 以内，
// 对二维码识别精度没有影响（码本身只占图里很小一块，且缩放后仍有足够像素）。
//
// 【inversionAttempts: 'attemptBoth'】深色底、浅色码（反色二维码）也常见，
// 只按默认的「黑码白底」识别会漏掉它们。

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import jsQR from 'jsqr';

/** 允许的最大源文件大小（再大先让用户自己压缩 —— 读取与解码都在主线程）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 解码前把最长边缩到这个值以内。 */
const MAX_DECODE_EDGE = 2000;

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : '未知错误';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败：文件可能已损坏或不是浏览器支持的图片格式'));
    img.src = src;
  });
}

export default function QrReadTool() {
  const [imageUrl, setImageUrl] = useState('');
  const [decoded, setDecoded] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 组件卸载时回收最后一个 ObjectURL（否则整张图会一直留在内存里）
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function handleFile(file: File): Promise<void> {
    setBusy(true);
    setError('');
    setDecoded('');
    setStatus('正在识别…');
    try {
      if (!file.type.startsWith('image/')) {
        throw new Error('请选择图片文件（PNG / JPEG / WebP / GIF）');
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请先压缩到 10MB 以内`);
      }

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const objectUrl = URL.createObjectURL(file);
      objectUrlRef.current = objectUrl;
      setImageUrl(objectUrl);

      const img = await loadImage(objectUrl);
      const sourceWidth = img.naturalWidth || img.width;
      const sourceHeight = img.naturalHeight || img.height;
      if (!sourceWidth || !sourceHeight) throw new Error('无法读取图片尺寸');

      const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法识别');

      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });

      if (!code || !code.data) {
        throw new Error(
          '没有在图片中识别到二维码。请确认二维码完整、清晰、对比度足够（也支持反色二维码）。'
        );
      }
      setDecoded(code.data);
      setStatus(
        `识别成功 · 图片 ${width}×${height}px${scale < 1 ? '（已等比缩小）' : ''} · 二维码版本 ${code.version}`
      );
    } catch (e) {
      setStatus('');
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function onPick(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) void handleFile(file);
    // 清空 value，允许连续选择同一个文件重试
    event.target.value = '';
  }

  async function copyDecoded(): Promise<void> {
    try {
      await navigator.clipboard.writeText(decoded);
      setStatus('已复制识别结果');
    } catch {
      setStatus('复制失败：浏览器拒绝访问剪贴板');
    }
  }

  return (
    <div className="devtool-split devtool-split--right">
      <div className="tool-panel p-3">
        <div
          className={`devtool-net-drop${dragOver ? ' devtool-net-drop--over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
        >
          <span>{busy ? '正在识别…' : '把二维码图片拖到这里'}</span>
          <span className="devtool-hint">或点击选择文件（PNG / JPEG / WebP / GIF，最大 10MB）</span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="u-hidden"
          onChange={onPick}
          aria-label="选择二维码图片"
        />

        <div className="devtool-net-stack">
          <p className="devtool-hint">
            图片不会上传：读取、缩放与解码全部在这个浏览器里完成，本站服务端收不到任何图片内容。
          </p>
          <p className="devtool-hint">
            最长边超过 {MAX_DECODE_EDGE}px 的图片会先等比缩小再识别；支持反色二维码。
          </p>
        </div>

        {error ? <p className="devtool-error">{error}</p> : null}
        {status && !error ? <p className="devtool-hint devtool-status">{status}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">识别结果</h2>
        {imageUrl ? (
          <div className="devtool-preview">
            <img className="devtool-net-preview-img" src={imageUrl} alt="待识别的二维码图片" />
          </div>
        ) : (
          <p className="devtool-hint">选择或拖入图片后，这里显示图片与识别出的文本。</p>
        )}

        {decoded ? (
          <>
            <label className="form-label" htmlFor="qr-read-result">
              解码文本
            </label>
            <textarea id="qr-read-result" className="devtool-input" rows={5} readOnly value={decoded} />
            <div className="devtool-bar">
              <button type="button" className="btn btn-outline-secondary" onClick={copyDecoded}>
                复制结果
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
