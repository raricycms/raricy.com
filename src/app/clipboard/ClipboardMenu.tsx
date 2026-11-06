'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clipboard } from 'lucide-react';
import { showToast } from '@/app/components/toast';

// 云剪贴板菜单
interface ClipItem {
  id: string;
  title: string;
  publicity: boolean;
  created_at: string | null;
}

// 点击 ID 直接复制（在 Link 内 preventDefault + stopPropagation，避免触发跳转，对齐 VoteCopyButton）
function ClipIdCopyButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(id)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => showToast('复制失败：' + id, 'error'));
    } else {
      showToast('剪贴板ID：' + id, 'info');
    }
  };

  return (
    <button type="button" className="clipboard-item__id" title="点击复制ID" onClick={copy}>
      <code>{id}</code>
      <span className="clipboard-item__id-hint">{copied ? '已复制' : '复制'}</span>
    </button>
  );
}

export default function ClipboardMenu() {
  const router = useRouter();
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  /** 加载失败的原因；null = 没失败。与「还没有剪贴板」必须可区分（见渲染处）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/clipboard', { credentials: 'same-origin' });
      const data = await res.json();
      if (data.code === 200) {
        setClips(data.clips ?? []);
        setNeedLogin(false);
      } else if (data.code === 401) {
        // 会话过期：别落进「还没有剪贴板」的空态，否则用户会以为内容丢了。
        setNeedLogin(true);
        setLoadError('登录状态已过期，请重新登录后查看');
      } else {
        setLoadError(data.message || '加载剪贴板失败');
      }
    } catch {
      setLoadError('网络错误，请稍后重试');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  function gotoClip() {
    const v = targetId.trim();
    if (v !== '') router.push(`/clipboard/${encodeURIComponent(v)}`);
    else showToast('目的地不能为空', 'warning');
  }

  return (
    <div className="clipboard-page">
      <h1 className="clipboard-title">云剪贴板</h1>

      <p className="clipboard-subtitle">保存并复用内容片段，不读取系统剪贴板。</p>

      <div className="clipboard-navigation">
        <div className="clipboard-navigation__search">
          <input
            type="text"
            className="search-input"
            placeholder="请输入目的地编号……"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          />
          <button type="button" className="search-button" onClick={gotoClip}>
            前往
          </button>
        </div>
        <div className="clipboard-navigation__actions">
          <Link href="/clipboard/guide" className="action-button">
            使用指南
          </Link>
          <Link href="/clipboard/upload" className="action-button primary">
            创建剪贴板
          </Link>
        </div>
      </div>

      {loadingList && (
        <div className="clipboard-list__empty">
          <div className="clipboard-list__empty-text">加载中…</div>
        </div>
      )}
      {!loadingList && loadError && (
        <div className="clipboard-list__empty">
          <div className="clipboard-list__empty-text">{loadError}</div>
          {needLogin ? (
            <Link href="/login" className="action-button primary">
              去登录
            </Link>
          ) : (
            <button type="button" className="read-btn" onClick={() => void loadList()}>
              重试
            </button>
          )}
        </div>
      )}
      {!loadingList && !loadError && clips.length > 0 && (
        <div className="clipboard-list">
          {clips.map((c) => (
            <Link key={c.id} href={`/clipboard/${c.id}`} className="clipboard-item">
              <div className="clipboard-item__title">{c.title}</div>
              <ClipIdCopyButton id={c.id} />
            </Link>
          ))}
        </div>
      )}
      {!loadingList && !loadError && clips.length === 0 && (
        <div className="clipboard-list__empty">
          <div className="clipboard-list__empty-icon" aria-hidden="true">
            <Clipboard />
          </div>
          <div className="clipboard-list__empty-text">还没有剪贴板</div>
          <div className="clipboard-list__empty-subtext">点击上方按钮创建你的第一个剪贴板。</div>
        </div>
      )}
    </div>
  );
}