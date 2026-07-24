'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// 云剪贴板菜单
function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface ClipItem {
  id: string;
  title: string;
  publicity: boolean;
  created_at: string | null;
}

export default function ClipboardMenu() {
  const router = useRouter();
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [targetId, setTargetId] = useState('');

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch('/api/clipboard', { credentials: 'same-origin' });
      const data = await res.json();
      if (data.code === 200) {
        setClips(data.clips ?? []);
        setNeedLogin(false);
      } else if (data.code === 401) {
        setNeedLogin(true);
      }
    } catch {
      // 忽略
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  void needLogin;

  function gotoClip() {
    const v = targetId.trim();
    if (v !== '') router.push(`/clipboard/${encodeURIComponent(v)}`);
    else showToast('目的地不能为空', 'warning');
  }

  return (
    <div className="clipboard-page">
      <h1 className="clipboard-title">云剪贴板</h1>

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
          <Link href="/clipboard/upload" className="action-button primary">
            创建剪贴板
          </Link>
        </div>
      </div>

      {(loadingList || clips.length > 0) && (
        <div className="clipboard-list">
          {clips.map((c) => (
            <Link key={c.id} href={`/clipboard/${c.id}`} className="clipboard-item">
              <div className="clipboard-item__header">
                <span className="clipboard-item__header-title">{c.title}</span>
                <span className="clipboard-item__header-id">{c.id}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {!loadingList && clips.length === 0 && (
        <div className="clipboard-list__empty">
          <div className="clipboard-list__empty-icon" aria-hidden="true">
            📋
          </div>
          <div className="clipboard-list__empty-text">还没有剪贴板</div>
          <div className="clipboard-list__empty-subtext">点击上方按钮创建你的第一个剪贴板。</div>
        </div>
      )}
    </div>
  );
}