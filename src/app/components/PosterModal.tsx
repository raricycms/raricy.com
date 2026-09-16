'use client';

import { useEffect, useState, type ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// PosterModal — 画报 / 收款码的预览与下载弹窗
//
// 图是**服务端渲染好的 PNG**（/api/poster/...），所以前端只有三件事：取图、预览、下载。
//
// 【为什么点开才取图】每次请求都会真的跑一遍 sharp 光栅化，还占生成配额
// （RULES.posterMinute）。页面一加载就取，等于每次看主页/看余额都白烧一次 CPU。
// 所以 <img> 只在弹窗打开时才挂进 DOM。
//
// 【失败态要说人话】路由在 SITE_URL 未配置时直接 503（那时二维码是废码，
// 宁可不出图）。图片加载失败的常见原因就两个：没配 SITE_URL、服务器缺中文字体。
// 提示里把这两条点到，省得对着一个破图猜。
// ─────────────────────────────────────────────────────────────────────────────

export default function PosterModal({
  label,
  src,
  downloadName,
  title,
  hint,
  triggerClassName,
}: {
  /** 触发按钮的内容（可以带图标 span） */
  label: ReactNode;
  /** PNG 地址 */
  src: string;
  /** 下载时的文件名 */
  downloadName: string;
  /** 弹窗标题 */
  title: string;
  /** 弹窗底部的说明 */
  hint: string;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // 每次打开都从头来一遍 —— 不然关掉再开会停在上一轮的 ready/failed
  useEffect(() => {
    if (!open) return;
    setState('loading');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {label}
      </button>

      {open && (
        <div className="modal-overlay show" onClick={() => setOpen(false)}>
          <div className="modal-dialog poster-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">{title}</h3>
                <button
                  type="button"
                  className="poster-close"
                  onClick={() => setOpen(false)}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>

              <div className="modal-body poster-body">
                <div className="poster-frame">
                  {/* 图要一直挂在 DOM 里：拿掉它就收不到 onLoad / onError。
                      display:none 的图片照样会加载、照样触发事件。 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="poster-frame__img"
                    src={src}
                    alt={title}
                    style={{ display: state === 'ready' ? 'block' : 'none' }}
                    onLoad={() => setState('ready')}
                    onError={() => setState('failed')}
                  />
                  {state === 'loading' && <p className="poster-state">正在生成…</p>}
                  {state === 'failed' && (
                    <p className="poster-state">
                      生成失败了，请稍后重试。
                      <br />
                      若一直失败：可能是服务器未配置 <code>SITE_URL</code>（拼不出二维码里
                      的网址），或缺少中文字体。
                    </p>
                  )}
                </div>

                {state === 'ready' && (
                  <>
                    <div className="poster-actions">
                      <a
                        className="poster-actions__btn poster-actions__btn--primary"
                        href={src}
                        download={downloadName}
                      >
                        下载 PNG
                      </a>
                      <a
                        className="poster-actions__btn"
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                      >
                        新标签打开
                      </a>
                    </div>
                    <p className="poster-hint">{hint}</p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
