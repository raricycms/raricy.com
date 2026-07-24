'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

// 投票跳转输入
export function VoteRedirect() {
  const router = useRouter();
  const [value, setValue] = useState('');

  const go = () => {
    const v = value.trim();
    if (v !== '') router.push(`/vote/${encodeURIComponent(v)}`);
    else showToast('请输入投票 ID', 'warning');
  };

  return (
    <div className="vote-navigation__search">
      <input
        type="text"
        className="search-input"
        placeholder="输入投票 ID 跳转……"
        id="target_link"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) go();
        }}
      />
      <button
        className="search-button"
        id="redirect"
        onClick={go}
      >
        前往
      </button>
    </div>
  );
}

// 复制投票 ID
export function VoteCopyButton({ id }: { id: string }) {
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
      showToast('投票 ID：' + id, 'info');
    }
  };

  return (
    <button className="vote-item__copy-btn" onClick={copy}>
      {copied ? '已复制' : '复制'}
    </button>
  );
}