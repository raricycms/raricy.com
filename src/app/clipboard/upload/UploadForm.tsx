'use client';

// 云剪贴板 上传/编辑表单
//
// - 编辑器：MarkdownEditor（CodeMirror 6，与博客共用），工具条带公式按钮。
// - Math（LaTeX）：预览走共享的整篇渲染管线（MathJax），`$inline$` / `$$block$$` 都能渲染。
// - 提交：新建 → POST /api/clipboard；编辑 → PUT /api/clipboard/:id。
// - 交互约定：Ctrl/⌘+S 手动保存、autoSave 每分钟自动保存、publicity 是否公开。
//
// 【保存逻辑留在本文件】草稿只负责「没保存成的那份正文」；Ctrl+S、每分钟自动保存、
// 提交后的跳转都在这里，因为它们的触发点（键盘、定时器、表单）本来就在表单这一层。
// ⚠️ **Ctrl+S 刻意不绑进 CM6 的 keymap**：那边绑一次、这里再监听一次，同一次按键
// 会发两遍保存请求（新建态就是两篇剪贴板）。
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/app/components/MarkdownEditor';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

/** 新建页的本地草稿键 —— 沿用 Vditor 时代的老键，见 lib/md-editor/draft.ts 文件头。 */
const DRAFT_KEY = 'clipboard-upload-editor';

export interface EditClip {
  id: string;
  title: string;
  content: string;
  publicity: boolean;
}

/**
 * 会进请求的全部字段 —— 拍快照与「保存之后又改了没」都只认这一处。
 * 判据**不能只看正文**：改了标题 / 公开状态而正文没动，同样没存上去。
 */
interface ClipFields {
  title: string;
  content: string;
  publicity: boolean;
}

const CLIP_LABELS: ReadonlyArray<readonly [keyof ClipFields, string]> = [
  ['title', '标题'],
  ['content', '正文'],
  ['publicity', '公开设置'],
];

export default function UploadForm({ clip }: { clip?: EditClip }) {
  const router = useRouter();
  const isEdit = !!clip;

  const [title, setTitle] = useState(clip?.title ?? '');
  const [content, setContent] = useState(clip?.content ?? '');
  const [publicity, setPublicity] = useState(clip ? clip.publicity : true);
  const [autoSave, setAutoSave] = useState(false);

  // 编辑器句柄；fallback 文本框给编辑器初始化失败时用。
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [initFailed, setInitFailed] = useState(false);
  const [fallbackValue, setFallbackValue] = useState(clip?.content ?? '');

  /** 在飞的那一笔保存（并发守卫：同一时刻只允许一笔）。 */
  const savingRef = useRef<Promise<void> | null>(null);
  /**
   * 上一笔**成功**保存时发出去的那份字段（null = 还没成功过一笔）。
   * 只在「提交撞上在飞的那一笔」这条路上用：等它落地之后，若表单还是那一份，
   * 这一次点击的意图已经达成，就不必再发第二笔（见 saveClipboard）。
   */
  const lastSavedRef = useRef<ClipFields | null>(null);
  /** 组件是否还挂着（异步回调据此判断「这一页还在不在」）。 */
  const aliveRef = useRef(true);

  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const publicityRef = useRef(publicity);
  titleRef.current = title;
  contentRef.current = content;
  publicityRef.current = publicity;

  // 取最新内容：编辑器具就绪就从它读，否则读兜底文本框。
  // 判据是 isReady() 而不是「ref 在不在」—— 初始化失败时 MarkdownEditor 渲染 null，
  // 但句柄仍挂在 ref 上，只看 ref 会提交一份**初始化那一刻**的旧正文。
  function getContent(): string {
    const editor = editorRef.current;
    if (editor?.isReady()) return editor.getDoc();
    return fallbackRef.current?.value ?? contentRef.current ?? '';
  }

  /** 取此刻表单里所有会进请求的字段（就是「这一刻会存上去的那一份」）。 */
  function readFields(): ClipFields {
    return {
      title: titleRef.current.trim(),
      // 正文一律走 getContent()：它会自己判编辑器是否真的起来了，起不来就回落到
      // 兜底 textarea（判据见上面那段注释）。**不要**在这里改读其它来源。
      content: getContent(),
      publicity: publicityRef.current,
    };
  }

  /** 相对快照改了哪几格（说人话的名字；没改就是空数组）。 */
  function changedLabels(snapshot: ClipFields, current: ClipFields): string[] {
    return CLIP_LABELS.filter(([key]) => snapshot[key] !== current[key]).map(([, label]) => label);
  }

  // 卸载 = 这一页已经不在了：异步回调据此不再弹提示、也不再 router.push
  // （那会把人从他**现在**这一页拽走）。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /**
   * 保存的入口（Ctrl+S / 每分钟自动保存 / 提交都走它）。
   *
   * ★ 一笔在飞时不再发第二笔 ★ 新建态两次 POST 就是**两篇剪贴板**（页面只跳去其中
   * 一篇，另一篇留在列表里，而用户根本没意识到自己存了两篇）。连按两下 Ctrl+S、
   * 自动保存与手动保存撞在一起都能触发这条。
   *
   * 两条路对「在飞的那一笔」的处理**刻意不同**：
   *   · 手动 / 自动保存（stayOnPage）—— 直接回一句「正在保存」，**不排队**。
   *   · 提交（!stayOnPage）—— 排队等它落地；等完**重新判锁**（可能又有人拿走了），
   *     并在「它已经存下了同一份字段」时把自己这次也省掉。见下面那段。
   */
  async function saveClipboard(stayOnPage: boolean): Promise<void> {
    const inflight = savingRef.current;
    if (inflight) {
      if (stayOnPage) {
        // 手动保存（Ctrl+S / 自动保存）与在飞的那一笔**互斥**：立刻回一句就不管了。
        // 排队会让「连点 Ctrl+S」变成连发好几笔 POST。
        toast('正在保存，请稍候', 'warning');
        return;
      }
      // 提交：等这一笔落地再接着走 —— 直接丢掉这次点击会让「更新」看着没反应。
      //
      // ★ 等完必须**再看一眼锁**，而且是循环地看 ★ 只 `await inflight` 一次是不够的：
      // 两个提交（连点两下按钮 / 提交撞上自动保存）会在**同一条**在飞的 Promise 上
      // 各挂一次，它一落地两边同时往下走，于是各自 doSave —— 从头到尾两笔写请求叠着跑，
      // 新建态就是**两篇剪贴板**（页面只跳去其中一篇）。
      // 循环的第 2 圈一定会看到「刚才那一笔已经把锁拿走了」（JS 单线程：拿锁那一段
      // 是同步的，不会被这两个等待者插进来），于是老实排队。
      while (savingRef.current) {
        await savingRef.current;
      }
      // 等待期间这一页可能已经被上一笔送走了（新建 / 更新成功后 router.push）
      // —— 从一个已经离开的页面里再写一笔，用户根本看不到结果。
      if (!aliveRef.current) return;
      // ★ 合并提交意图 ★ 刚落地的那一笔**成功**且存的就是现在这一份 → 这次点击
      // 要做的事已经做完了，不必再发一笔。少了这一条，连点两下「提交」在新建态
      // 仍然会留下两篇内容完全一样的剪贴板（一笔是等待后补发的）。
      const last = lastSavedRef.current;
      if (last && changedLabels(last, readFields()).length === 0) return;
    }
    const run = doSave(stayOnPage);
    savingRef.current = run;
    try {
      await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  }

  async function doSave(stayOnPage: boolean) {
    // 存的是**这一刻**的表单：之后不管用户怎么改，成功回调都用这一份做判断。
    const data = readFields();

    if (!data.title || !data.content) {
      toast('标题和正文不能为空', 'warning');
      return;
    }
    if (data.title.length > 30) {
      toast('标题不能超过30个字符', 'warning');
      return;
    }
    if (data.content.length > 250000) {
      toast('正文不能超过250000个字符', 'warning');
      return;
    }

    try {
      // 编辑态命中 PUT /api/clipboard/[id]；
      // 新建态命中 POST /api/clipboard。
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
      // 这一页可能已经不在了（用户点了别处）—— 那就什么也别做：不再弹提示，
      // 更不 router.push（那会把人从**他现在**这一页上拽走）。
      if (!aliveRef.current) return;
      if (response.ok && result.code === 200) {
        // 记下「服务端现在持有的就是这一份」—— 撞上在飞那一笔的提交据此判断
        // 自己的意图是不是已经达成（见 saveClipboard）。只有成功才记：失败那一笔
        // 什么都没存下，不能拿来吞掉下一次点击。
        lastSavedRef.current = data;
        // ★ 请求在飞的时候用户还能接着改 ★ —— 那一段**没被存上去**。
        // 成功回调只说明「保存那一刻那一份存下来了」，不说明「页面上现在这一份」。
        // 判据是**整份表单快照**（标题 / 正文 / 公开状态），不是「刚保存过」这个事件，
        // 也不是只比正文：
        //   · 没变 → 草稿已完成使命，清掉（否则下次进新建页会把一篇**已经发出去**的
        //     剪贴板当成「没写完的草稿」恢复出来）；
        //   · 变了 → 草稿正是那一段还没保存的新改动，**留着**（顺手 flush 一次，把防抖
        //     窗口里那 500ms 也落下）。清掉它 = 把用户刚打的字丢掉，而同一时刻还会
        //     弹一句「保存成功」，看着像已经存好了。
        // 清完之后接着写仍会攒新草稿（见 draft.ts 的 clear()）。
        // 编辑态没有草稿键，什么都不清。
        const changed = changedLabels(data, readFields());
        const bodyChanged = changed.includes('正文');
        if (!isEdit) {
          if (bodyChanged) editorRef.current?.flushDraft();
          else editorRef.current?.clearDraft();
        }
        if (stayOnPage) {
          toast('保存成功！', 'success');
          // 保存后**不离开页面**是剪贴板新建页的主路径，所以这里必须说清楚：
          // 绿字说的只是「刚才那一份存下来了」，之后敲的字还在本地。
          // ⚠️ 点名改了哪几格 —— 草稿只存正文，标题 / 公开状态改了是接不住的，
          // 混成一句「有些改动还在本地」会让人以为它们也留下来了。
          if (changed.length > 0) {
            toast(
              `保存的是按下保存那一刻的${changed.join('、')}；之后的改动` +
                (!isEdit && bodyChanged ? '还在本地草稿里' : '还在编辑器里，记得再存一次'),
              'warning'
            );
          }
        } else if (isEdit && changed.length > 0) {
          // 编辑态**不跳**：跳走等于把刚改的那些一起丢掉，而编辑页没有草稿接住它们。
          // 留在这儿再点一次「更新」是安全的（PUT 幂等，不会多出一条）。
          toast(
            `保存的是按下保存那一刻的${changed.join('、')}；之后你又改了 —— 这次不跳转，请再保存一次`,
            'warning'
          );
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
    // 提交前停止自动保存。
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
          <br />
          支持 Markdown 与 LaTeX（<code>$inline$</code> / <code>{'$$block$$'}</code>）。
        </div>
      )}

      {!isEdit && (
        <div className="clipboard-form__reminder">
          支持 Markdown 与 LaTeX（<code>$inline$</code> / <code>{'$$block$$'}</code>）。
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
            <label htmlFor="clipboard-editor">正文（支持 Markdown 与 LaTeX）</label>
            {/* 外观全在 .md-editor（styles-scss/components/_markdown-editor.scss）；
                `#clipboard-editor` 这个 id 只是表单与 e2e 的元素钩子。
                只有新建页给草稿键：编辑态的正文是服务端那一份，本地草稿在编辑态
                既不读也不写 —— 否则「上次新建到一半的半成品」会盖掉正在编辑的正文。 */}
            <MarkdownEditor
              id="clipboard-editor"
              ref={editorRef}
              initialValue={clip?.content ?? ''}
              draftKey={isEdit ? undefined : DRAFT_KEY}
              title={title}
              withMath
              height="50vh"
              onNotify={toast}
              onInitError={(value) => {
                setFallbackValue(value);
                setInitFailed(true);
              }}
            />
            {initFailed && (
              <>
                <p
                  id="clipboard-editor-fallback-message"
                  className="clipboard-form__reminder"
                  style={{ marginTop: '8px' }}
                >
                  Markdown 编辑器加载失败，已切换到基础文本输入框。
                </p>
                <textarea
                  id="clipboard-editor-fallback"
                  ref={fallbackRef}
                  rows={15}
                  placeholder="请输入正文内容"
                  className="clipboard-form__fallback"
                  value={fallbackValue}
                  onChange={(e) => setFallbackValue(e.target.value)}
                />
              </>
            )}
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

          {/* 「是否公开」的**真实边界**（默认是勾上的）。此前只有一句「勾选则所有人可见」，
              而站内从来没有「公开剪贴板」的浏览列表 —— listUserClips 只按 authorId 取自己的
              （clipboard-service.ts），所以「公开」=「拿到 8 位 ID 的人能读到」，
              不是「挂到某个广场上」。写宽了会把唯一的价值主张（能被站外读者看到）吓掉，
              写窄了就是撒谎 —— 所以只写 getClip / listUserClips 里读得出来的那两条边界。 */}
          <span className="form-hint text-muted">
            公开：站内成员凭这 8 位 ID 就能读到；若嵌进对外公开的博客，站外读者也会看到其中的
            内容。它不会出现在任何列表里，搜索引擎也搜不到。
            <br />
            私密：只有你本人（和站长）能读；嵌进博客后，站外读者看到的是 <code>[@ID]</code> 原文。
          </span>

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
