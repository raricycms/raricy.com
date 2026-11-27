// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-host-view.test.tsx — ChatRmdHostView（`chat-ref` 宿主组件）的渲染契约
//
// 覆盖：
//   · 图床 / 音频 / 表情 / 黄脸 / 名片的受控渲染与逐 slot 失败回退；
//     音频解码错误（含 0 秒 / 坏文件）保留播放器结构，不缩回 token；
//   · 非法 id 与伪造 hostData 不获得能力（URL 一律由校验后的字段重拼）；
//   · 剪贴板 Markdown / ReactiveMD 子文档内层 static 渲染、不递归展开、未知格式只给回链；
//   · 未知 kind 仍显示原文 token。
//
// 用真实适配器 + 假的 reference-reader 生成 hostData，保证视图消费的就是 B 的
// 真实输出形状（slot 编号、组件标签、字段名）。
// ─────────────────────────────────────────────────────────────────────────────

import { act, useCallback, useMemo, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileLocal, type LocalDocument } from 'reactive-md';
import ChatRmdDocument from '@/app/chat/ChatRmdDocument';
import {
  ChatRmdHostView,
  type ChatRmdHostEnvironment,
} from '@/app/chat/ChatRmdHostView';
import { CHAT_RMD_COMPILE_OPTIONS, chatReactiveUrlPolicy } from '@/lib/chat-rmd/options';
import { adaptChatReferences } from '@/lib/chat-rmd/references';
import type { ChatReferenceDocument } from '@/lib/chat-rmd/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── 取数替身：真实适配器 + 可控 reader ───────────────────────────────────────
const readerStore = vi.hoisted(() => ({
  clipboard: new Map<string, unknown>(),
  users: new Map<string, unknown>(),
  clipboardCalls: [] as string[],
  userCalls: [] as string[],
}));

vi.mock('@/lib/chat-rmd/reference-reader', () => ({
  createChatReferenceReader: () => ({
    readClipboard: async (id: string) => {
      readerStore.clipboardCalls.push(id);
      return readerStore.clipboard.get(id) ?? { status: 'error' };
    },
    readUserCard: async (name: string) => {
      readerStore.userCalls.push(name);
      return readerStore.users.get(name) ?? { status: 'error' };
    },
  }),
  clearChatReferenceCache: () => {},
}));

const BUDGET = { images: 50, audio: 3, stickers: 30, users: 5, clipboard: 1 };

function compile(source: string): LocalDocument {
  const result = compileLocal(source, CHAT_RMD_COMPILE_OPTIONS);
  if (!result.ok) throw new Error('fixture compile failed: ' + source);
  return result.document;
}

async function adapt(source: string): Promise<ChatReferenceDocument> {
  const controller = new AbortController();
  return adaptChatReferences(compile(source), {
    viewerScope: 'viewer-1',
    signal: controller.signal,
    compileChild: async (childSource) => {
      const result = compileLocal(childSource, CHAT_RMD_COMPILE_OPTIONS);
      return result.ok ? result.document : null;
    },
    budget: BUDGET,
    depth: 0,
  });
}

// ── 渲染壳：与 ChatRmdMessage 相同的 hostData / 失败汇总接线 ─────────────────
function Harness({
  reference,
  onImageClick,
  soloEmojiSlot = null,
}: {
  reference: ChatReferenceDocument;
  onImageClick?: (url: string) => void;
  soloEmojiSlot?: string | null;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const env = useMemo<ChatRmdHostEnvironment>(
    () => ({
      hostData: reference.hostData,
      failedSlots: failed,
      soloEmojiSlot,
      allowClipboard: true,
      urlPolicy: chatReactiveUrlPolicy,
      onImageClick,
      onMediaSettled: (slot, isFailed) => {
        if (!isFailed) return;
        setFailed((previous) => {
          if (previous.has(slot)) return previous;
          const next = new Set(previous);
          next.add(slot);
          return next;
        });
      },
    }),
    [reference, failed, onImageClick, soloEmojiSlot]
  );
  const renderer = useCallback(
    (node: Parameters<typeof ChatRmdHostView>[0], data: unknown, ctx: unknown) =>
      ChatRmdHostView(node, data, ctx, env),
    [env]
  );
  return (
    <ChatRmdDocument
      document={reference.document}
      hostData={reference.hostData}
      hostRenderer={renderer}
      urlPolicy={chatReactiveUrlPolicy}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  readerStore.clipboard.clear();
  readerStore.users.clear();
  readerStore.clipboardCalls.length = 0;
  readerStore.userCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function dispatch(target: Element, type: 'error' | 'load' | 'click' | 'loadedmetadata'): void {
  act(() => {
    if (type === 'click') target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    else target.dispatchEvent(new Event(type));
  });
}

describe('ChatRmdHostView — 图床与音频', () => {
  it('图床用受控地址渲染，点击回调拿到同一地址', async () => {
    const onImageClick = vi.fn();
    const reference = await adapt('[@AbCdEf1234]');
    await render(<Harness reference={reference} onImageClick={onImageClick} />);

    const img = container.querySelector('img.rich-image-ref');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/api/images/AbCdEf1234/raw');
    expect(img!.getAttribute('loading')).toBe('lazy');

    dispatch(img!, 'click');
    expect(onImageClick).toHaveBeenCalledWith('/api/images/AbCdEf1234/raw');
  });

  it('逐 slot 失败互不影响：一张失败回 token，另一张继续显示', async () => {
    const reference = await adapt('[@AbCdEf1234] 与 [@ZzYyXx9876]');
    await render(<Harness reference={reference} />);

    const images = [...container.querySelectorAll('img.rich-image-ref')];
    expect(images).toHaveLength(2);
    dispatch(images[0], 'error');

    expect(container.querySelectorAll('img.rich-image-ref')).toHaveLength(1);
    expect(container.textContent).toContain('[@AbCdEf1234]');
  });

  it('非法 imageId / 伪造 URL 直接显示 token，不建 img', async () => {
    const reference = await adapt('[@AbCdEf1234]');
    const slot = Object.keys(reference.hostData)[0];
    reference.hostData[slot] = {
      kind: 'image',
      slot,
      token: '[@AbCdEf1234]',
      imageId: '../../etc/passwd',
      url: 'javascript:alert(1)',
    };
    await render(<Harness reference={reference} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[@AbCdEf1234]');
  });

  it('音频用原生控件、preload=none，解码错误仍保留播放器结构', async () => {
    const reference = await adapt('[@音频/AbCdEf1234]');
    await render(<Harness reference={reference} />);

    const audio = container.querySelector('audio.rich-audio-ref');
    expect(audio).not.toBeNull();
    expect(audio!.classList.contains('chat-rmd-audio')).toBe(true);
    expect(audio!.getAttribute('src')).toBe('/api/audio/AbCdEf1234/raw');
    expect(audio!.getAttribute('preload')).toBe('none');
    expect(audio!.hasAttribute('controls')).toBe(true);

    dispatch(audio!, 'error');
    expect(container.querySelector('audio.rich-audio-ref')).not.toBeNull();
    expect(container.textContent).not.toContain('[@音频/AbCdEf1234]');
  });

  it('duration=0 的 loadedmetadata 与后续 error 都不会把音频换回 token', async () => {
    const reference = await adapt('[@音频/AbCdEf1234] [@音频/ZzYyXx9876]');
    await render(<Harness reference={reference} />);

    const audios = [...container.querySelectorAll('audio.rich-audio-ref')];
    expect(audios).toHaveLength(2);
    for (const audio of audios) {
      // 0 秒录音仍会正常触发 loadedmetadata；时长不参与失败判定。
      Object.defineProperty(audio, 'duration', { configurable: true, value: 0 });
      dispatch(audio, 'loadedmetadata');
    }
    expect(container.querySelectorAll('audio.rich-audio-ref')).toHaveLength(2);
    expect(container.textContent).not.toContain('[@音频/');

    // 只有 ID3 头的 0 秒文件会报解码错误；引用本身仍保留播放器。
    Object.defineProperty(audios[1], 'error', { configurable: true, value: { code: 4 } });
    dispatch(audios[1], 'error');
    expect(container.querySelectorAll('audio.rich-audio-ref')).toHaveLength(2);
    expect(container.textContent).not.toContain('[@音频/ZzYyXx9876]');
  });

  it('非法音频 URL / 缺失 url 的载荷都回 token，不建 audio', async () => {
    const payloads = [
      { url: 'https://example.com/evil.mp3' },
      { url: '/api/audio/AbCdEf1234/raw?x=1' },
      {},
    ];
    for (const payload of payloads) {
      const reference = await adapt('[@音频/AbCdEf1234]');
      const slot = Object.keys(reference.hostData)[0];
      reference.hostData[slot] = {
        kind: 'audio',
        slot,
        token: '[@音频/AbCdEf1234]',
        ...payload,
      };
      await render(<Harness reference={reference} />);
      expect(container.querySelector('audio')).toBeNull();
      expect(container.textContent).toContain('[@音频/AbCdEf1234]');
    }
  });
});

describe('ChatRmdHostView — 表情与名片', () => {
  it('图片表情与内置黄脸各带自己的类名，单颗黄脸可叠 solo 类', async () => {
    const reference = await adapt('[@猫猫/开心] [@黄脸/微笑]');
    const stickerSlots = Object.entries(reference.hostData).map(([slot, data]) => ({
      slot,
      data: data as { kind: string; emoji?: boolean },
    }));
    const emojiSlot = stickerSlots.find((entry) => entry.data.emoji === true)!.slot;
    const stickerSlot = stickerSlots.find((entry) => entry.data.kind === 'sticker' && !entry.data.emoji)!.slot;

    await render(<Harness reference={reference} soloEmojiSlot={emojiSlot} />);
    const stickers = [...container.querySelectorAll('img.rich-sticker-ref')];
    expect(stickers).toHaveLength(2);
    const emoji = container.querySelector('img.rich-emoji-ref');
    expect(emoji).not.toBeNull();
    expect(emoji!.classList.contains('rich-emoji-solo')).toBe(true);
    const plain = stickers.find((img) => img !== emoji)!;
    expect(plain.classList.contains('rich-emoji-ref')).toBe(false);
    expect(plain.getAttribute('src')).toMatch(/^\/api\/stickers\//);

    dispatch(emoji!, 'error');
    expect(container.textContent).toContain('[@黄脸/微笑]');
    expect(container.querySelectorAll('img.rich-sticker-ref')).toHaveLength(1);
    expect(stickerSlot).toBeTruthy();
  });

  it('名片使用 hostData 的头像 / 头像框 / 站内主页链接', async () => {
    readerStore.users.set('张三丰', {
      status: 'ready',
      card: { id: 'user-1', username: '张三丰', frameUrl: '/api/frames/ring' },
    });
    const reference = await adapt('[@用户/张三丰]');
    await render(<Harness reference={reference} />);

    const link = container.querySelector('a.rich-user-ref');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/u/user-1');
    const avatar = link!.querySelector('span.rich-user-ref__avatar img.avatar__img');
    expect(avatar!.getAttribute('src')).toBe('/api/avatar/user-1');
    const frame = link!.querySelector('img.avatar__frame');
    expect(frame!.getAttribute('src')).toBe('/api/frames/ring');
    expect(link!.textContent).toContain('张三丰');
  });

  it('名片取数失败时保留原文 token', async () => {
    const reference = await adapt('[@用户/李四]');
    await render(<Harness reference={reference} />);
    expect(container.querySelector('a.rich-user-ref')).toBeNull();
    expect(container.textContent).toContain('[@用户/李四]');
  });
});

describe('ChatRmdHostView — 剪贴板', () => {
  it('Markdown 子文档内层 static 渲染，子剪贴板不再递归展开', async () => {
    readerStore.clipboard.set('AbCdEf12', {
      status: 'ready',
      format: 'markdown',
      content: '子文档 **加粗** [@ZzYyXx99]',
    });
    const reference = await adapt('parent [@AbCdEf12]');
    await render(<Harness reference={reference} />);

    // 父文档 + 子文档各一层 md-document，没有第三层。
    expect(container.querySelectorAll('.md-document')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toContain('加粗');
    // 子剪贴板里的 token 保持文字，不出现第二条回链 / 第二份内联文档。
    expect(container.textContent).toContain('[@ZzYyXx99]');
    expect(container.querySelector('a[href="/clipboard/ZzYyXx99"]')).toBeNull();
    // 子文档没有交互控件。
    const inner = container.querySelectorAll('.md-document')[1];
    expect(inner.querySelectorAll('button, input, textarea, select')).toHaveLength(0);
  });

  it('ReactiveMD 子文档同样内联渲染，未知格式只给站内回链', async () => {
    readerStore.clipboard.set('AbCdEf12', {
      status: 'ready',
      format: 'reactive',
      content: 'RMD 子文档',
    });
    const reference = await adapt('[@AbCdEf12]');
    await render(<Harness reference={reference} />);

    expect(container.querySelectorAll('.md-document')).toHaveLength(2);
    expect(container.textContent).toContain('RMD 子文档');
    expect(container.querySelector('a.chat-rmd-clipboard-link')).toBeNull();

    readerStore.clipboard.set('ZzYyXx99', {
      status: 'ready',
      format: 'unknown',
      content: '库内认不出的正文',
    });
    const unknown = await adapt('[@ZzYyXx99]');
    await render(<Harness reference={unknown} />);

    const link = container.querySelector('a.chat-rmd-clipboard-link');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/clipboard/ZzYyXx99');
    expect(container.querySelectorAll('.md-document')).toHaveLength(1);
    expect(container.textContent).not.toContain('库内认不出的正文');
  });

  it('超长剪贴板内联截断正文并给回链', async () => {
    readerStore.clipboard.set('AbCdEf12', {
      status: 'ready',
      format: 'markdown',
      content: '长'.repeat(2200),
    });
    const reference = await adapt('[@AbCdEf12]');
    await render(<Harness reference={reference} />);

    expect(container.querySelectorAll('.md-document')).toHaveLength(2);
    expect(container.querySelector('a.chat-rmd-clipboard-link')).not.toBeNull();
  });
});

describe('ChatRmdHostView — 伪造与未知载荷', () => {
  it('节点没有对应 hostData 时不渲染任何能力', async () => {
    const reference = await adapt('[@AbCdEf1234]');
    await render(<Harness reference={{ ...reference, hostData: {} }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('未知 kind 仍把原文 token 还给读者', async () => {
    const reference = await adapt('[@AbCdEf1234]');
    const slot = Object.keys(reference.hostData)[0];
    reference.hostData[slot] = {
      kind: 'mystery',
      slot,
      token: '[@AbCdEf1234]',
      payload: { src: 'javascript:alert(1)' },
    };
    await render(<Harness reference={reference} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[@AbCdEf1234]');
  });
});