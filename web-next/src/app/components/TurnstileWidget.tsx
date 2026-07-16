'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TurnstileWidget — Cloudflare Turnstile 客户端小组件。
//
// 仅当 NEXT_PUBLIC_TURNSTILE_AVAILABLE === 'True' 时加载 CF 脚本并渲染 widget，
// 每次校验完成通过 onToken(token) 回调把 token 交给表单；否则不渲染任何内容
// （镜像 Flask：未启用 Turnstile 时注册页无验证控件）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

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
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!available || !siteKey) return;

    let cancelled = false;

    function renderWidget() {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) return; // 已渲染，避免重复
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
      let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', renderWidget);
    }

    return () => {
      cancelled = true;
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
  return <div ref={containerRef} style={{ margin: '4px 0' }} />;
}
