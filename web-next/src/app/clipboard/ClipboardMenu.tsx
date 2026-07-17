'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ── 全局 toast（原站 base.js 注入 window.showToast） ──────────────────────────
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
      // 忽略：保持空列表
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 保留 needLogin 状态供 fetch 使用（原站靠后端装饰器 403/重定向，页面本身不渲染登录面板）
  void needLogin;

  function gotoClip() {
    // 与 Flask 原站一致：只有点击「前往」触发跳转；空值弹 warning toast，回车无效
    const v = targetId.trim();
    if (v !== '') router.push(`/clipboard/${encodeURIComponent(v)}`);
    else showToast('目的地不能为空', 'warning');
  }

  return (
    <div className="pwrap">
      <h1 className="ptitle" style={{ margin: 0 }}>云剪贴板</h1>

      <div className="item-toolbar">
        <div className="search-form" style={{ maxWidth: '420px' }}>
          <input
            type="text"
            className="search-input"
            placeholder="请输入目的地编号……"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          />
          <button className="search-btn" onClick={gotoClip}>
            前往
          </button>
        </div>
        <Link href="/clipboard/upload" className="upload-button">
          <span className="icon icon-add"></span>创建剪贴板
        </Link>
      </div>

      {/* 列表区始终渲染（加载中先占位空列表），避免出现空状态误闪 */}
      {(loadingList || clips.length > 0) && (
        <div className="clip-list">
          {clips.map((c) => (
            <Link key={c.id} href={`/clipboard/${c.id}`} className="card card--link clip-item">
              <span className="clip-item__title">{c.title}</span>
              <span className="clip-item__id">{c.id}</span>
            </Link>
          ))}
        </div>
      )}
      {!loadingList && clips.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">
            <span className="icon icon-clipboard" style={{ width: '2.4rem', height: '2.4rem', display: 'inline-block' }}></span>
          </div>
          <h3>还没有剪贴板</h3>
          <p>点击上方按钮创建你的第一个剪贴板。</p>
        </div>
      )}
    </div>
  );
}
