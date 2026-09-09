'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';

// FrameBuster —— 页面被**跨站** <iframe> 嵌入时，弹一个居中模态框，给用户「跳出」入口。
//
// 【只跨站弹】同站嵌入（hostname 相同或互为子域）与正常访问一律不渲染任何东西。
// 跨站嵌入时会话 cookie 是 SameSite=Lax（src/lib/session.ts），iframe 子请求根本带不上
// 它 —— 用户明明登录着，嵌进来的页面却显示未登录，且不报任何错，所以这里值得用最强的
// 方式提示一次；同站嵌入 cookie 照常发送、功能一切正常，没必要打扰。
//
// 【为什么不能自动跳】浏览器禁止跨域 iframe 静默导航顶层窗口（否则任意广告页都能
// 劫持整个浏览器窗口），顶层跳转必须由用户手势触发。所以这里只做两件事：检测是否
// 被嵌、渲染一个 <a target="_top">，真正的跳转交给点击本身。
//
// 【检测】window.self !== window.top 只比较引用，同域跨域都安全；去读
// window.top.location 才会因跨域抛 SecurityError。放在 useEffect 而非渲染期：
// SSR 没有 window，且正常访问时不该先渲染一个框再被移除（代价是水合后才弹，页面
// 会先画出来 —— 无法避免，除非在 layout 里塞阻塞脚本）。
//
// 【确证不了就静默】topAncestorOrigin() 返回 null 时（Firefox 无 ancestorOrigins、
// 嵌入方又设了 Referrer-Policy: no-referrer）什么都不渲染 —— 证明不了跨站就不打扰，
// 代价是这一小撮 Firefox 用户看不到跳出入口。
//
// 【误判】isSameSite 只比 hostname，兄弟子域（a.raricy.com 嵌 b.raricy.com）会被
// 当成跨站，多弹一个框 —— 无害，宁多勿少。
//
// 【失效场景】父页面若写了 <iframe sandbox> 且未开 allow-top-navigation(-by-user-activation)，
// 点击会被浏览器静默拦下 —— 子页面无法绕过，只能靠响应头 CSP frame-ancestors 从源头拒绝。

/** 最顶层祖先 frame 的 origin；取不到返回 null。 */
function topAncestorOrigin(): string | null {
  // Chrome / Edge / Safari：ancestorOrigins 列出所有祖先 frame 的 origin（由近及远）。
  // 跨域 iframe 里读自己 Location 的这个属性是允许的。
  const { ancestorOrigins } = window.location;
  if (ancestorOrigins && ancestorOrigins.length) {
    return ancestorOrigins[ancestorOrigins.length - 1];
  }
  // Firefox 没有 ancestorOrigins：退回 referrer。iframe 的 referrer 就是嵌入方文档，
  // 默认策略 strict-origin-when-cross-origin 下至少能拿到它的 origin。
  // 若嵌入方设了 Referrer-Policy: no-referrer 则这里为空 → 当作同站（宁可少提示一句）。
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* 非法 URL，忽略 */
    }
  }
  return null;
}

/** 粗粒度同站判定：域名相同或互为子域。精确判定要公共后缀表，不值得为此引依赖；
 *  兄弟子域（a.raricy.com 嵌 b.raricy.com）会被误判成跨站，多弹一个框，无害。 */
function isSameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase();
    const hb = new URL(b).hostname.toLowerCase();
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch {
    return true; // 解析失败 → 保守按同站，不打扰用户
  }
}

export default function FrameBuster() {
  const [embed, setEmbed] = useState<{ href: string; embedder: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.self === window.top) return; // 正常访问，不渲染
    const top = topAncestorOrigin();
    if (!top || isSameSite(top, window.location.origin)) return; // 同站 / 证明不了跨站 → 静默
    setEmbed({ href: window.location.href, embedder: top });
  }, []);

  // 弹窗打开期间：Esc 关闭 + 焦点锁在卡片内 + 背景不滚动。
  // Esc 监听挂在 window 上 —— 用户点到嵌入方页面后，跨域 iframe 收不到按键，
  // 只能靠点回 iframe 区域或按钮；这是浏览器边界，绕不过去。
  useEffect(() => {
    if (!embed) return;
    const close = () => setEmbed(null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // 极简焦点陷阱：aria-modal 声称其余内容 inert，不锁的话 Tab 能跑到遮罩后面操作页面，
      // 与「只能用按钮/Esc 关」矛盾。不引依赖，也不做 inert 遍历。
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [embed]);

  if (!embed) return null;

  return (
    /* 遮罩是纯展示层：不挂 onClick —— 点背景不关，只能走按钮 / Esc */
    <div className="frame-buster">
      <div
        className="frame-buster__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="frame-buster-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="frame-buster__header">
          <h2 className="frame-buster__title" id="frame-buster-title">
            页面被嵌入在其它网站中
          </h2>
          <button
            type="button"
            className="frame-buster__close"
            onClick={() => setEmbed(null)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <p className="frame-buster__text">
          此页面正被 <strong className="frame-buster__origin">{embed.embedder}</strong> 以
          iframe 嵌入。跨站嵌入时浏览器不会带上登录凭证，页面会显示为未登录，部分功能也不可用。
        </p>
        <div className="frame-buster__actions">
          <button type="button" className="frame-buster__btn" onClick={() => setEmbed(null)}>
            继续浏览
          </button>
          <a
            className="frame-buster__btn frame-buster__btn--primary"
            href={embed.href}
            target="_top"
          >
            <ExternalLink size={16} aria-hidden="true" />
            全屏打开
          </a>
        </div>
      </div>
    </div>
  );
}
