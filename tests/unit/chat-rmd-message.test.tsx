// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-message.test.tsx — ChatRmdMessage / ChatRmdProvider 的视图契约
//
// 用假 Manager 注入确定的编译快照，用真实引用适配器 + 假 reference-reader 验证
// final 落位。覆盖：
//   · 成功渲染、编译失败转义源码、空正文；
//   · 聊天策略放行的静态组件（alert）渲染标题 / 正文，不回显原始源码；
//   · streaming 不请求引用 / 媒体、链接不可导航；
//   · final 适配后 hostData 落位，裸图类随 allowBareImage / 媒体失败开关；
//   · 逐 slot 失败与 token 回退；
//   · 黄脸 solo 类由最终结构计算；
//   · 子剪贴板内层静态渲染；
//   · provider 卸载 unsubscribe / dispose，旧 revision 不覆盖新结果。
//
// 不写纯样式或文案断言；这里只认结构、类名契约与资源请求。
// ─────────────────────────────────────────────────────────────────────────────

import { act, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileLocal, type LocalDocument } from 'reactive-md';
import ChatRmdMessage from '@/app/chat/ChatRmdMessage';
import ChatRmdProvider, { useChatRmd } from '@/app/chat/ChatRmdProvider';
import { applyChatDocumentPolicy } from '@/lib/chat-rmd/document-policy';
import { CHAT_RMD_COMPILE_OPTIONS } from '@/lib/chat-rmd/options';
import type {
  ChatCompileListener,
  ChatCompileManager,
  ChatCompileRequest,
  ChatSourcePhase,
} from '@/lib/chat-rmd/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── 引用取数替身（真实适配器消费它）────────────────────────────────────────
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
  // provider 卸载 / 切号时清理页面级名片缓存；测试替身无需缓存。
  clearChatReferenceCache: () => {},
}));

function compile(source: string): LocalDocument {
  const result = compileLocal(source, CHAT_RMD_COMPILE_OPTIONS);
  if (!result.ok) throw new Error('fixture compile failed: ' + source);
  return result.document;
}

// ── 假 Manager：记录订阅 / 支持人工投递 / 子编译自动回落 ──────────────────────
interface FakeRecord {
  request: ChatCompileRequest;
  listener: ChatCompileListener;
  active: boolean;
}

function createFakeManager() {
  const records: FakeRecord[] = [];
  const history: FakeRecord[] = [];
  const requests: ChatCompileRequest[] = [];
  const unsubscribed: string[] = [];
  const warmupCalls = vi.fn();
  let disposed = 0;

  const manager: ChatCompileManager = {
    warmup: warmupCalls,
    subscribe(request, listener) {
      const record: FakeRecord = { request, listener, active: true };
      records.push(record);
      history.push(record);
      requests.push(request);
      if (request.key.startsWith('child:')) {
        queueMicrotask(() => {
          if (!record.active) return;
          const result = compileLocal(request.source, CHAT_RMD_COMPILE_OPTIONS);
          listener({
            key: request.key,
            revision: request.revision,
            phase: 'final',
            document: result.ok ? result.document : null,
            errorCode: result.ok ? null : 'local.compile',
          });
        });
      }
      return () => {
        record.active = false;
        const index = records.indexOf(record);
        if (index >= 0) records.splice(index, 1);
        unsubscribed.push(request.key);
      };
    },
    dispose() {
      disposed += 1;
      for (const record of records) record.active = false;
      records.length = 0;
    },
  };

  function deliver(record: FakeRecord, document: LocalDocument | null, errorCode: string | null = null) {
    // 与真实 Manager 一致：结果异步回到视图，测试里的 act() 会把它冲干净。
    queueMicrotask(() => {
      record.listener({
        key: record.request.key,
        revision: record.request.revision,
        phase: record.request.phase,
        document,
        errorCode,
      });
    });
  }

  return {
    manager,
    requests,
    history,
    unsubscribed,
    warmupCalls,
    get disposed() {
      return disposed;
    },
    /** 当前仍生效的最新请求（按 key / phase 过滤）。 */
    latest(key: string, phase?: ChatSourcePhase): FakeRecord | null {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record.request.key !== key) continue;
        if (phase && record.request.phase !== phase) continue;
        return record;
      }
      return null;
    },
    deliverLatest(key: string, document: LocalDocument | null, phase?: ChatSourcePhase) {
      const record = this.latest(key, phase);
      if (!record) throw new Error(`no active request for ${key}`);
      deliver(record, document);
      return record;
    },
    /** 模拟迟到回调：即使已经退订也照发，验证视图按 revision / active 丢弃。 */
    deliverTo(record: FakeRecord, document: LocalDocument | null) {
      deliver(record, document);
    },
  };
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  container.remove();
});

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface MessageProps {
  messageKey?: string;
  content: string;
  phase: ChatSourcePhase;
  allowBareImage?: boolean;
  onImageClick?: (url: string) => void;
  onBeforeContentChange?: () => void;
  onContentChange?: () => void;
}

function tree(fake: ReturnType<typeof createFakeManager>, props: MessageProps): ReactElement {
  return (
    <ChatRmdProvider viewerScope="viewer-1" manager={fake.manager}>
      <ChatRmdMessage
        messageKey={props.messageKey ?? 'msg:1'}
        content={props.content}
        phase={props.phase}
        allowBareImage={props.allowBareImage}
        onImageClick={props.onImageClick}
        onBeforeContentChange={props.onBeforeContentChange}
        onContentChange={props.onContentChange}
      />
    </ChatRmdProvider>
  );
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function rootBox(): HTMLElement {
  const box = container.querySelector<HTMLElement>('.chat-msg__md');
  if (!box) throw new Error('missing .chat-msg__md');
  return box;
}

function dispatch(target: Element, type: 'error' | 'load' | 'click'): void {
  act(() => {
    if (type === 'click') target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    else target.dispatchEvent(new Event(type));
  });
}

describe('ChatRmdProvider — Worker 预热', () => {
  it('挂载后的下一个任务就预热，不等 requestIdleCallback', async () => {
    const idle = vi.fn();
    const originalIdle = (window as unknown as Record<string, unknown>).requestIdleCallback;
    (window as unknown as Record<string, unknown>).requestIdleCallback = idle;
    try {
      const fake = createFakeManager();
      await render(tree(fake, { content: '预热', phase: 'final' }));

      // effect 只排了 setTimeout(0)，本轮 act 还没有让定时器跑。
      expect(fake.warmupCalls).not.toHaveBeenCalled();
      await settle(1);
      expect(fake.warmupCalls).toHaveBeenCalledTimes(1);
      expect(idle).not.toHaveBeenCalled();
    } finally {
      if (originalIdle === undefined) {
        delete (window as unknown as Record<string, unknown>).requestIdleCallback;
      } else {
        (window as unknown as Record<string, unknown>).requestIdleCallback = originalIdle;
      }
    }
  });
});

function ChildCompileProbe({
  onDone,
}: {
  onDone: (document: LocalDocument | null) => void;
}) {
  const context = useChatRmd();
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    void context.compileChild('child-source', controller.signal).then(onDone);
    return () => controller.abort();
  }, [context, onDone]);
  return null;
}

describe('ChatRmdProvider — 子编译瞬时失败', () => {
  it('worker.unavailable 不结束子编译，等成功快照后再返回', async () => {
    const compiled = compileLocal('child-source', CHAT_RMD_COMPILE_OPTIONS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('unreachable');

    let request: ChatCompileRequest | null = null;
    let listener: ChatCompileListener | null = null;
    const manager: ChatCompileManager = {
      subscribe(nextRequest, nextListener) {
        request = nextRequest;
        listener = nextListener;
        queueMicrotask(() => {
          nextListener({
            key: nextRequest.key,
            revision: nextRequest.revision,
            phase: 'final',
            document: null,
            errorCode: 'worker.unavailable',
            retryable: true,
          });
        });
        return () => {
          listener = null;
        };
      },
      dispose() {},
    };
    const onDone = vi.fn();

    await render(
      <ChatRmdProvider viewerScope="viewer-1" manager={manager}>
        <ChildCompileProbe onDone={onDone} />
      </ChatRmdProvider>
    );
    await settle(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(request).not.toBeNull();
    expect(listener).not.toBeNull();

    await act(async () => {
      listener!({
        key: request!.key,
        revision: request!.revision,
        phase: 'final',
        document: compiled.document,
        errorCode: null,
      });
      await Promise.resolve();
    });
    expect(onDone).toHaveBeenCalledWith(compiled.document);
  });
});

describe('ChatRmdMessage — 编译结果与回退', () => {
  it('final 编译成功后渲染文档，引用落位为受控图片', async () => {
    const fake = createFakeManager();
    const source = 'hello **world** [@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final' }));

    const record = fake.latest('msg:1', 'final');
    expect(record).not.toBeNull();
    expect(record!.request.source).toBe(source);

    await act(async () => {
      fake.deliverTo(record!, compile(source));
    });
    await settle();

    const box = rootBox();
    expect(box.classList.contains('chat-msg__md--source')).toBe(false);
    expect(box.querySelector('strong')?.textContent).toBe('world');
    const image = box.querySelector('img.rich-image-ref');
    expect(image?.getAttribute('src')).toBe('/api/images/AbCdEf1234/raw');
  });

  it('编译失败显示完整源码（React 文本节点，不解析 HTML）', async () => {
    const fake = createFakeManager();
    const source = '<b>not html</b> [x](javascript:alert(1))';
    await render(tree(fake, { content: source, phase: 'final' }));
    fake.deliverLatest('msg:1', null);
    await settle();

    const box = rootBox();
    expect(box.classList.contains('chat-msg__md--source')).toBe(true);
    expect(box.textContent).toBe(source);
    expect(box.querySelector('b')).toBeNull();
    expect(box.querySelector('a')).toBeNull();
  });

  it('空正文不渲染根节点', async () => {
    const fake = createFakeManager();
    await render(tree(fake, { content: '   ', phase: 'final' }));
    expect(container.querySelector('.chat-msg__md')).toBeNull();
  });

  it('无 provider（SSR / 无 Manager）时仍显示源码', async () => {
    await render(<ChatRmdMessage messageKey="msg:1" content={'plain *text*'} phase="final" />);
    const box = rootBox();
    expect(box.classList.contains('chat-msg__md--source')).toBe(true);
    expect(box.textContent).toBe('plain *text*');
  });
});

describe('ChatRmdMessage — 聊天策略文档', () => {
  it('策略放行的 alert 渲染标题与正文，不出现原始源码', async () => {
    const fake = createFakeManager();
    const source =
      '<alert tone="warning" title="Two checks still open">\nThe release can stage at **now**\n</alert>';
    const policy = applyChatDocumentPolicy(compile(source));
    expect(policy.ok, JSON.stringify(policy)).toBe(true);
    if (!policy.ok) throw new Error('unreachable');

    await render(tree(fake, { content: source, phase: 'final' }));
    const record = fake.latest('msg:1', 'final');
    expect(record).not.toBeNull();
    await act(async () => {
      fake.deliverTo(record!, policy.document);
    });
    await settle();

    const box = rootBox();
    expect(box.classList.contains('chat-msg__md--source')).toBe(false);
    const alert = box.querySelector('.local-alert');
    expect(alert).not.toBeNull();
    expect(alert!.querySelector('.local-alert-title')?.textContent).toBe(
      'Two checks still open'
    );
    expect(alert!.querySelector('.local-alert-body')?.textContent).toContain(
      'The release can stage at'
    );
    expect(alert!.querySelector('strong')?.textContent).toBe('now');
    expect(box.textContent).not.toContain('<alert');
  });

  it('策略放行的 text 颜色与 div align 渲染', async () => {
    const fake = createFakeManager();
    const source =
      '<text color="blue">蓝色 **文字**</text>\n\n<div align="right">\n## 第一幕：碎裂的回响\n</div>';
    const policy = applyChatDocumentPolicy(compile(source));
    expect(policy.ok, JSON.stringify(policy)).toBe(true);
    if (!policy.ok) throw new Error('unreachable');

    await render(tree(fake, { content: source, phase: 'final' }));
    const record = fake.latest('msg:1', 'final');
    expect(record).not.toBeNull();
    await act(async () => {
      fake.deliverTo(record!, policy.document);
    });
    await settle();

    const box = rootBox();
    const text = box.querySelector('.local-text');
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain('蓝色');
    expect(text!.querySelector('strong')?.textContent).toBe('文字');
    expect(box.textContent).not.toContain('<text');

    const heading = [...box.querySelectorAll('h2')].find((node) =>
      node.textContent?.includes('第一幕')
    );
    expect(heading).toBeDefined();
    const div = heading!.parentElement;
    expect(div?.tagName).toBe('DIV');
    expect(div?.getAttribute('align') === 'right' || (div as HTMLElement).style.textAlign === 'right').toBe(true);
  });
});

describe('ChatRmdMessage — streaming 约束', () => {
  it('不请求引用与媒体，链接不可导航', async () => {
    const fake = createFakeManager();
    const source =
      'stream **x** [link](https://example.com/) [@AbCdEf12] [@用户/张三丰] ![](/api/images/AbCdEf1234/raw)';
    await render(tree(fake, { content: source, phase: 'streaming' }));

    const record = fake.latest('msg:1', 'streaming');
    expect(record).not.toBeNull();
    await act(async () => {
      fake.deliverTo(record!, compile(source));
    });
    await settle();

    const box = rootBox();
    expect(box.textContent).toContain('stream');
    // 引用 token 仍是字面量：streaming 不进入引用适配。
    expect(box.textContent).toContain('[@AbCdEf12]');
    expect(box.querySelector('a')).toBeNull();
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('audio')).toBeNull();
    expect(readerStore.clipboardCalls).toHaveLength(0);
    expect(readerStore.userCalls).toHaveLength(0);
    // 只有正文编译，没有任何子剪贴板编译请求。
    expect(fake.requests.every((request) => request.key === 'msg:1')).toBe(true);
  });

  it('streaming 阶段即使正文只有一张图片也不加裸图类', async () => {
    const fake = createFakeManager();
    const source = '[@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'streaming' }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    const box = rootBox();
    expect(box.classList.contains('chat-msg__md--single-image')).toBe(false);
    expect(box.textContent).toContain('[@AbCdEf1234]');
  });
});

describe('ChatRmdMessage — final 引用与裸图', () => {
  it('裸图类随 allowBareImage 与媒体失败开关', async () => {
    const fake = createFakeManager();
    const source = '[@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final', allowBareImage: true }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    let box = rootBox();
    expect(box.classList.contains('chat-msg__md--single-image')).toBe(true);

    const image = box.querySelector('img.rich-image-ref');
    expect(image).not.toBeNull();
    dispatch(image!, 'error');
    box = rootBox();
    expect(box.classList.contains('chat-msg__md--single-image')).toBe(false);
    expect(box.textContent).toContain('[@AbCdEf1234]');

    // 换一条允许/不允许都由 DTO 决定。
    fake.deliverLatest('msg:1', compile(source));
    await settle();
    await render(tree(fake, { content: source, phase: 'final', allowBareImage: false }));
    await settle();
    box = rootBox();
    expect(box.classList.contains('chat-msg__md--single-image')).toBe(false);
  });

  it('单图带首尾空白 / 换行或包在强调里时仍是裸图，正文只剩图片', async () => {
    const fake = createFakeManager();
    const cases = [
      { key: 'msg:bare-1', source: '[@AbCdEf1234]\n' },
      { key: 'msg:bare-2', source: '  [@AbCdEf1234]  ' },
      { key: 'msg:bare-3', source: '**[@AbCdEf1234]**' },
    ];
    for (const { key, source } of cases) {
      await render(tree(fake, { messageKey: key, content: source, phase: 'final' }));
      fake.deliverLatest(key, compile(source));
      await settle();

      const box = rootBox();
      // 气泡收缩到图片宽度全靠这个类（_chat.scss 的单图段）；残留 token 文本
      // 或漏类都会让图片重新被撑到气泡一侧、另一侧留空白。
      expect(box.classList.contains('chat-msg__md--single-image')).toBe(true);
      expect(box.querySelectorAll('img.rich-image-ref')).toHaveLength(1);
      expect(box.textContent?.trim()).toBe('');
    }
  });

  it('正文带其他内容时不是裸图', async () => {
    const fake = createFakeManager();
    const source = '看图 [@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final' }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    const box = rootBox();
    expect(box.querySelector('img.rich-image-ref')).not.toBeNull();
    expect(box.classList.contains('chat-msg__md--single-image')).toBe(false);
  });

  it('逐 slot 失败只回退失败的那一处', async () => {
    const fake = createFakeManager();
    const source = '[@AbCdEf1234] [@ZzYyXx9876]';
    await render(tree(fake, { content: source, phase: 'final' }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    const images = [...rootBox().querySelectorAll('img.rich-image-ref')];
    expect(images).toHaveLength(2);
    dispatch(images[0], 'error');

    const box = rootBox();
    expect(box.querySelectorAll('img.rich-image-ref')).toHaveLength(1);
    expect(box.textContent).toContain('[@AbCdEf1234]');
    expect(box.textContent).not.toContain('[@ZzYyXx9876]');
  });

  it('图片点击回调拿到受控地址', async () => {
    const fake = createFakeManager();
    const onImageClick = vi.fn();
    const source = '[@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final', onImageClick }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    const image = rootBox().querySelector('img.rich-image-ref')!;
    dispatch(image, 'click');
    expect(onImageClick).toHaveBeenCalledWith('/api/images/AbCdEf1234/raw');
  });

  it('final 链接可导航（站内策略）', async () => {
    const fake = createFakeManager();
    const source = '[link](https://example.com/)';
    await render(tree(fake, { content: source, phase: 'final' }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();

    const link = rootBox().querySelector('a[href="https://example.com/"]');
    expect(link).not.toBeNull();
  });

  it('单颗内置黄脸叠 rich-emoji-solo，混入文字后不叠', async () => {
    const fake = createFakeManager();
    const soloSource = '[@黄脸/微笑]';
    await render(tree(fake, { content: soloSource, phase: 'final' }));
    fake.deliverLatest('msg:1', compile(soloSource));
    await settle();
    let box = rootBox();
    expect(box.querySelector('img.rich-emoji-ref')).not.toBeNull();
    expect(box.querySelector('img.rich-emoji-solo')).not.toBeNull();

    const mixedSource = '你好 [@黄脸/微笑]';
    await render(tree(fake, { content: mixedSource, phase: 'final' }));
    await settle();
    const mixedRecord = fake.latest('msg:1', 'final');
    await act(async () => {
      fake.deliverTo(mixedRecord!, compile(mixedSource));
    });
    await settle();
    box = rootBox();
    expect(box.querySelector('img.rich-emoji-ref')).not.toBeNull();
    expect(box.querySelector('img.rich-emoji-solo')).toBeNull();
  });

  it('Markdown 子剪贴板内层 static 渲染', async () => {
    const fake = createFakeManager();
    readerStore.clipboard.set('AbCdEf12', {
      status: 'ready',
      format: 'markdown',
      content: 'child **doc**',
    });
    const source = '[@AbCdEf12]';
    await render(tree(fake, { content: source, phase: 'final' }));
    fake.deliverLatest('msg:1', compile(source));
    await settle(10);

    const box = rootBox();
    expect(box.querySelectorAll('.md-document')).toHaveLength(2);
    expect(box.querySelector('strong')?.textContent).toBe('doc');
    expect(fake.requests.some((request) => request.key.startsWith('child:'))).toBe(true);
  });
});

describe('ChatRmdMessage — 通知、卸载与竞态', () => {
  it('编译提交 / 引用落位 / 媒体 load 后通知 onContentChange', async () => {
    const fake = createFakeManager();
    const onContentChange = vi.fn();
    const source = '[@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final', onContentChange }));
    fake.deliverLatest('msg:1', compile(source));
    await settle();
    expect(onContentChange).toHaveBeenCalled();

    const image = rootBox().querySelector('img.rich-image-ref')!;
    const before = onContentChange.mock.calls.length;
    dispatch(image, 'load');
    expect(onContentChange.mock.calls.length).toBeGreaterThan(before);

    // 通知不应反过来触发无限重渲染。
    const stable = onContentChange.mock.calls.length;
    await settle(3);
    expect(onContentChange.mock.calls.length).toBe(stable);
  });

  it('内容变化前先调用 onBeforeContentChange，提交后才调用 onContentChange', async () => {
    const fake = createFakeManager();
    const events: string[] = [];
    const onBeforeContentChange = vi.fn(() => {
      events.push('before');
    });
    const onContentChange = vi.fn(() => {
      events.push('after');
    });
    const source = '[@AbCdEf1234]';
    await render(tree(fake, { content: source, phase: 'final', onBeforeContentChange, onContentChange }));

    // ① final 文档 / 引用落位：从变化开始记录，before 必须先于对应的 after。
    events.length = 0;
    fake.deliverLatest('msg:1', compile(source));
    await settle(10);
    expect(onBeforeContentChange).toHaveBeenCalled();
    expect(onContentChange).toHaveBeenCalled();
    expect(events[0]).toBe('before');
    // 每个 after 都必须有一个尚未消费的 before（编译提交、引用落位各成一对）。
    let pendingBefore = 0;
    for (const event of events) {
      if (event === 'before') {
        pendingBefore += 1;
      } else {
        expect(pendingBefore).toBeGreaterThan(0);
        pendingBefore -= 1;
      }
    }

    // ② 成功的媒体 load 发生在浏览器应用图片尺寸之后：不能再记录 before（那会覆盖
    // 引用落位前的正确快照），只应触发 after；失败回退 token 时才记录 before。
    const image = rootBox().querySelector('img.rich-image-ref')!;
    events.length = 0;
    dispatch(image, 'load');
    await settle(3);
    expect(events).toContain('after');
    expect(events).not.toContain('before');
  });

  it('provider 卸载时 unsubscribe 并 dispose', async () => {
    const fake = createFakeManager();
    await render(tree(fake, { content: 'hello', phase: 'final' }));
    expect(fake.requests.length).toBeGreaterThan(0);
    const record = fake.latest('msg:1', 'final')!;

    await act(async () => {
      root.unmount();
    });
    await settle(3);
    expect(fake.unsubscribed).toContain('msg:1');
    expect(fake.disposed).toBe(1);

    // 卸载后的迟到结果不产生异常 / 不重新挂载。
    expect(() => fake.deliverTo(record, compile('late'))).not.toThrow();
    expect(container.querySelector('.chat-msg__md')).toBeNull();

    // afterEach 会再次 unmount；重建 root 避免重复卸载报错。
    root = createRoot(container);
  });

  it('旧 revision 的迟到结果不覆盖新结果', async () => {
    const fake = createFakeManager();
    await render(tree(fake, { content: 'first version', phase: 'final' }));
    const first = fake.latest('msg:1', 'final')!;

    await render(tree(fake, { content: 'second version **bold**', phase: 'final' }));
    const second = fake.latest('msg:1', 'final')!;
    expect(second.request.revision).toBeGreaterThan(first.request.revision);

    await act(async () => {
      fake.deliverTo(first, compile('STALE CONTENT'));
    });
    await settle();
    expect(rootBox().textContent).not.toContain('STALE CONTENT');

    await act(async () => {
      fake.deliverTo(second, compile('second version **bold**'));
    });
    await settle();
    expect(rootBox().textContent).toContain('second version');
    expect(rootBox().querySelector('strong')?.textContent).toBe('bold');

    await act(async () => {
      fake.deliverTo(first, compile('STALE AGAIN'));
    });
    await settle();
    expect(rootBox().textContent).not.toContain('STALE AGAIN');
  });
});