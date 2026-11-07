'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TurnstileWidget — Cloudflare Turnstile 客户端小组件。
//
// 仅当 NEXT_PUBLIC_TURNSTILE_AVAILABLE === 'True' 时加载 CF 脚本并渲染 widget，
// 每次校验完成通过 onToken(token) 回调把 token 交给表单；否则不渲染任何内容
// （未启用 Turnstile 时注册页无验证控件）。
// ─────────────────────────────────────────────────────────────────────────────

// 【R3-639 / D 桶已批准】脚本被拦截 / 离线 / CSP 挡住时，以前 onToken 一次都不调、
// 页面上也**没有任何可见提示**，用户只会看到提交后服务端恒 400「人机验证失败」。
// 现在组件给出可见提示（关闭拦截插件 / 换网络 / 重试）；服务端仍保持 400 不放行
// （不做安全策略降级）。提交按钮禁用态仍需消费方按「没有 token」判定。

import { useEffect, useRef, useState } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** 脚本加载超时（毫秒）——被 CSP / 插件静默拦掉时不会触发 error 事件。 */
const LOAD_TIMEOUT_MS = 10_000;

// Turnstile 的全局 API（脚本注入后挂到 window.turnstile）。
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export default function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
  const available = process.env.NEXT_PUBLIC_TURNSTILE_AVAILABLE === 'True';
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const [failed, setFailed] = useState(false);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!available || !siteKey) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let script: HTMLScriptElement | null = null;

    const markFailed = () => {
      if (cancelled) return;
      setFailed(true);
      onTokenRef.current(''); // 明确告诉表单「没有 token」
    };

    function renderWidget() {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) return; // 已渲染，避免重复
      setFailed(false);
      if (timer) clearTimeout(timer);
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey as string,
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current(''),
      });
    }

    // 脚本已存在（如软导航返回）→ 直接渲染；否则注入脚本后渲染。
    if (window.turnstile) {
      renderWidget();
    } else {
      script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
        // 加载失败（CSP / 插件 / 离线）触发 error；静默拦截靠超时兜底。
        script.addEventListener('error', markFailed);
        timer = setTimeout(markFailed, LOAD_TIMEOUT_MS);
      }
      script.addEventListener('load', renderWidget);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (script) {
        script.removeEventListener('load', renderWidget);
        script.removeEventListener('error', markFailed);
      }
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* noop */
        }
        widgetIdRef.current = null;
      }
    };
  }, [available, siteKey]);

  if (!available || !siteKey) return null;
  return (
    <div>
      <div ref={containerRef} style={{ margin: '4px 0' }} />
      {failed && (
        <p className="text-danger small mb-0" role="alert">
          人机验证没有加载出来。请关闭广告/脚本拦截插件、换一个网络后刷新页面重试；
          验证不通过时注册无法提交。
        </p>
      )}
    </div>
  );
}
