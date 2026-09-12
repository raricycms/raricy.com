// sse.ts —— SSE 传输契约的唯一出处（响应头 + 帧格式 + 重连/背压常量）。
//
// 【为什么值得单独测】`no-transform` 的后果是**全站 SSE 实时性归零** ——
// next start 的压缩中间件会把事件 gzip 攒到流结束才发（实测 4 条拖到 +1241ms
// 一次性到达）。这个故障单测看不见行为、构建也不报错、页面还 200，
// 唯一能拦住「有人顺手删掉这个头」的就是这里。
//
// 同理，`id:` 行是浏览器回传 Last-Event-ID 做断线补齐的唯一依据，格式错了
// 重连就补不回事件，而且同样不报错。

import { describe, it, expect } from 'vitest';
import { SSE_HEADERS, SSE_QUEUE_LIMIT, SSE_RETRY_MS, sseFrame } from '@/lib/sse';

describe('sse：响应头', () => {
  it('Cache-Control 必须同时含 no-cache 与 no-transform（后者不可省）', () => {
    expect(SSE_HEADERS['Cache-Control']).toContain('no-cache');
    expect(SSE_HEADERS['Cache-Control']).toContain('no-transform');
  });

  it('Content-Type 是 text/event-stream 且带 charset', () => {
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream; charset=utf-8');
  });

  it('带 nginx 侧禁缓冲头与 keep-alive', () => {
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
    expect(SSE_HEADERS.Connection).toBe('keep-alive');
  });

  it('重连间隔与背压阈值是正整数', () => {
    expect(SSE_RETRY_MS).toBeGreaterThan(0);
    expect(SSE_QUEUE_LIMIT).toBeGreaterThan(0);
  });
});

describe('sse：帧格式', () => {
  it('带 id 的帧形如 "id: N\\ndata: {...}\\n\\n"', () => {
    expect(sseFrame({ type: 'move' }, 42)).toBe('id: 42\ndata: {"type":"move"}\n\n');
  });

  it('不带 id 的帧没有 id: 行（注释帧/心跳不能污染 Last-Event-ID）', () => {
    expect(sseFrame({ type: 'resync' })).toBe('data: {"type":"resync"}\n\n');
  });

  it('id 为 0 时仍写出 id 行（0 是合法 revision，不能当 falsy 吞掉）', () => {
    expect(sseFrame({ type: 'x' }, 0)).toBe('id: 0\ndata: {"type":"x"}\n\n');
  });
});
