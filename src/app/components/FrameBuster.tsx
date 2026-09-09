'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

// FrameBuster —— 页面被第三方站点用 <iframe> 嵌入时，给用户一个「跳出」入口。
//
// 【为什么不能自动跳】浏览器禁止跨域 iframe 静默导航顶层窗口（否则任意广告页都能
// 劫持整个浏览器窗口），顶层跳转必须由用户手势触发。所以这里只做两件事：检测是否
// 被嵌、渲染一个 <a target="_top">，真正的跳转交给点击本身。
//
// 【检测】window.self !== window.top 只比较引用，同域跨域都安全；去读
// window.top.location 才会因跨域抛 SecurityError。放在 useEffect 而非渲染期：
// SSR 没有 window，且正常访问时不该先渲染一个按钮再被移除。
//
// 【为什么区分同站/跨站】会话 cookie 是 SameSite=Lax（src/lib/session.ts），跨站
// iframe 里浏览器根本不会带上它 —— 用户明明登录着，嵌进来的页面却显示未登录，且
// 不报任何错。所以跨站时文案要说明「登录状态得靠全屏打开才能恢复」；同站（含子域）
// 嵌入 cookie 照常发送，用默认文案即可。
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
 *  兄弟子域（a.raricy.com 嵌 b.raricy.com）会被误判成跨站，只多提示一句，无害。 */
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
  const [embed, setEmbed] = useState<{ url: string; crossSite: boolean } | null>(null);

  useEffect(() => {
    if (window.self === window.top) return; // 正常访问，不渲染
    const top = topAncestorOrigin();
    setEmbed({
      url: window.location.href,
      crossSite: top ? !isSameSite(top, window.location.origin) : false,
    });
  }, []);

  if (!embed) return null;

  return (
    <div className="frame-buster">
      <span className="frame-buster__text">
        {embed.crossSite ? '登录状态下请全屏打开' : '当前页面在 iframe 中打开'}
      </span>
      <a className="frame-buster__btn" href={embed.url} target="_top">
        <ExternalLink size={16} aria-hidden="true" />
        全屏打开
      </a>
    </div>
  );
}
