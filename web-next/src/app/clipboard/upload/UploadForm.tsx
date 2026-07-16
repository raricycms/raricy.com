'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export interface EditClip {
  id: string;
  title: string;
  content: string;
  publicity: boolean;
}

export default function UploadForm({ clip }: { clip?: EditClip }) {
  const router = useRouter();
  const isEdit = !!clip;

  const [title, setTitle] = useState(clip?.title ?? '');
  const [content, setContent] = useState(clip?.content ?? '');
  const [publicity, setPublicity] = useState(clip ? clip.publicity : true);
  const [autoSave, setAutoSave] = useState(false);

  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const publicityRef = useRef(publicity);
  titleRef.current = title;
  contentRef.current = content;
  publicityRef.current = publicity;

  async function saveClipboard(stayOnPage: boolean) {
    const data = {
      title: titleRef.current,
      content: contentRef.current,
      publicity: publicityRef.current,
    };
    try {
      // 编辑态命中 PUT /api/clipboard/[id]（对齐 Flask POST /clipboard/<id>/edit）；
      // 新建态命中 POST /api/clipboard（对齐 Flask POST /clipboard/upload）。
      const url = isEdit ? `/api/clipboard/${clip!.id}` : '/api/clipboard';
      const method = isEdit ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (response.ok && result.code === 200) {
        if (stayOnPage) {
          toast('保存成功！', 'success');
        } else {
          router.push(`/clipboard/${result.id}`);
        }
      } else {
        const msg = result.message || '未知错误';
        if (stayOnPage) {
          toast(`保存失败：${msg}`, 'error');
        } else {
          alert(`上传失败，原因：${msg}`);
        }
      }
    } catch (error) {
      console.error(error);
      const msg = '出错了qaq，快去找raricy';
      if (stayOnPage) {
        toast(msg, 'error');
      } else {
        alert(msg);
      }
    }
  }

  // 用 ref 持有最新的 save 函数，供定时器与快捷键调用。
  const saveRef = useRef(saveClipboard);
  saveRef.current = saveClipboard;

  // Ctrl+S / Cmd+S 手动保存（新建态与编辑态一致）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveRef.current(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // 编辑态：从 localStorage 读取「自动保存」偏好。
  useEffect(() => {
    if (!isEdit) return;
    setAutoSave(localStorage.getItem('clipboard_autosave_enabled') === 'true');
  }, [isEdit]);

  // 编辑态：开启后每分钟自动保存一次。
  useEffect(() => {
    if (!isEdit || !autoSave) return;
    const timer = setInterval(() => {
      void saveRef.current(true);
    }, 60000);
    return () => clearInterval(timer);
  }, [isEdit, autoSave]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 提交前停止自动保存（对齐 Flask stopAutoSave()）。
    setAutoSave(false);
    await saveClipboard(false);
  }

  function onToggleAutoSave(checked: boolean) {
    localStorage.setItem('clipboard_autosave_enabled', String(checked));
    setAutoSave(checked);
  }

  return (
    <div className="clipboard-page">
      <h1 className="clipboard-title">
        {isEdit ? `${clip!.title} 文章编辑` : '上传云剪贴板'}
      </h1>

      {isEdit && (
        <div className="clipboard-form__reminder">
          提示：编辑过程中可按 <kbd>Ctrl+S</kbd> 手动保存，以免内容丢失。也可以勾选下方
          {'"自动保存"'}开关，每分钟自动保存一次。
        </div>
      )}

      <div className="clipboard-form">
        <form id="uploadForm" onSubmit={onSubmit}>
          <div className="clipboard-form__group">
            <label htmlFor="title">标题</label>
            <input
              type="text"
              id="title"
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入标题"
              required
            />
          </div>

          <div className="clipboard-form__group">
            <label htmlFor="content">正文</label>
            <textarea
              id="content"
              name="content"
              placeholder="请输入正文内容"
              rows={15}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>

          <div className="clipboard-form__group clipboard-form__group--checkbox">
            <input
              type="checkbox"
              id="publicity"
              name="publicity"
              checked={publicity}
              onChange={(e) => setPublicity(e.target.checked)}
            />
            <label htmlFor="publicity">是否公开</label>
          </div>

          {isEdit && (
            <div className="clipboard-form__group clipboard-form__group--checkbox">
              <input
                type="checkbox"
                id="autoSaveToggle"
                name="autoSave"
                checked={autoSave}
                onChange={(e) => onToggleAutoSave(e.target.checked)}
              />
              <label htmlFor="autoSaveToggle">自动保存（每分钟）</label>
            </div>
          )}

          <button type="submit" className="clipboard-form__submit">
            {isEdit ? '更新' : '提交'}
          </button>
        </form>
      </div>
    </div>
  );
}
