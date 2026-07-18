'use client';

// 剪贴板详情的客户端交互层：把 Flask detail.html 里的原生 JS 逻辑用 React 等价实现。
//   - 行内 ID 复制按钮（.clipboard-detail__header__inline-copy）
//   - 底部操作栏（编辑 / 删除 / 复制正文 / 返回主页 / 返回上页）
//   - 正文图片点击放大（覆盖层，与 Flask addImageZoom 一致，纯内联样式）
// 正文渲染仍交给 MarkdownRenderer（不改该组件）。
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';

// 通用文本复制 + 按钮反馈（对齐 Flask copyTextToClipboard / fallbackCopy）
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到 fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-999999px';
    ta.style.top = '-999999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 页脚版权覆写：对齐 Flask 模板的 {% block copyright %} 覆写。
// 共享 Footer（layout 里渲染）不可改，故在客户端把 .footer-copy 文本替换掉，
// 卸载时还原——效果等价于 Flask detail.html / 403.html 覆写 copyright 块。
export function FooterCopyright({ text }: { text: string }) {
  useEffect(() => {
    const el = document.querySelector('.footer-copy');
    if (!el) return;
    const prev = el.textContent;
    el.textContent = text;
    return () => {
      el.textContent = prev;
    };
  }, [text]);
  return null;
}

// 行内 ID 复制按钮（复制成功后短暂显示"已复制"）
export function ClipIdCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="clipboard-detail__header__inline-copy"
      data-copy={text}
      title="复制ID"
      disabled={copied}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } else {
          alert('复制失败，请手动复制');
        }
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

// 底部操作栏
export function ClipActions({
  clipId,
  content,
  isAuthor,
  canDelete,
}: {
  clipId: string;
  content: string;
  isAuthor: boolean;
  canDelete: boolean;
}) {
  const [copied, setCopied] = useState(false);

  // 删除（对齐 Flask delete_clipboard：确认 → DELETE 当前路径 → 成功回主页）
  const handleDelete = async () => {
    if (!confirm('确认要删除吗？')) return;
    try {
      const res = await fetch(`/clipboard/${clipId}`, { method: 'DELETE' });
      if (res.ok) {
        alert('删除成功！');
        window.location.href = '/clipboard';
      } else {
        alert('删除失败qaq');
      }
    } catch (err) {
      alert('删除失败qaq');
      console.error('删除失败:', err);
    }
  };

  const handleCopyContent = async () => {
    if (await copyText(content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      alert('内容读取失败');
    }
  };

  return (
    <div className="clipboard-detail__actions">
      {isAuthor && (
        <button
          className="action-button primary"
          onClick={() => window.open(`${window.location.pathname}/edit`)}
        >
          编辑文章
        </button>
      )}
      {canDelete && (
        <button className="action-button danger" onClick={handleDelete}>
          删除文章
        </button>
      )}
      <button className="action-button" disabled={copied} onClick={handleCopyContent}>
        {copied ? '已复制' : '复制正文'}
      </button>
      <Link href="/clipboard" className="action-button">
        返回云剪贴板主页
      </Link>
      <button className="action-button" onClick={() => history.back()}>
        返回上页
      </button>
    </div>
  );
}

// 正文容器 + 图片点击放大（对齐 Flask addImageZoom；正文本身由 MarkdownRenderer 渲染）
export function ClipContent({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const zoom = (src: string) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;z-index:9999;cursor:pointer;';
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'max-width:90%;max-height:90%;object-fit:contain;border-radius:8px;';
      overlay.appendChild(img);
      overlay.addEventListener('click', () => document.body.removeChild(overlay));
      document.body.appendChild(overlay);
    };

    const bound = new WeakSet<HTMLImageElement>();
    const bind = () => {
      root.querySelectorAll('img').forEach((el) => {
        const img = el as HTMLImageElement;
        if (bound.has(img)) return;
        bound.add(img);
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => zoom(img.src));
      });
    };

    // MarkdownRenderer 通过 effect 异步注入 HTML，用 MutationObserver 兜住后续渲染
    const obs = new MutationObserver(bind);
    obs.observe(root, { childList: true, subtree: true });
    bind();
    return () => obs.disconnect();
  }, []);

  return (
    <div className="clipboard-markdown-content" ref={ref}>
      <MarkdownRenderer content={content} />
    </div>
  );
}
