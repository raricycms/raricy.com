// ─────────────────────────────────────────────────────────────────────────────
// gomoku-ai.worker.ts — 把单机五子棋的 AI 搜索挪到 worker 线程。
//
// 【为什么必须用 worker】普通档的思考时间是**秒级**的（墙钟预算，见
// gomoku-ai.ts 的 PARAMS）。搜索是纯同步的紧循环，跑在主线程上就是整页冻死
// 那么多秒：不能滚动、点不了「新游戏」、切不了模式，浏览器还可能在标题上弹
// 「页面无响应」——「AI 思考中…」那行字虽然是画出来了，但它定格不动，看着
// 像卡死而不是在思考。挪到 worker 之后主线程全程空闲，指示器可以是活的。
//
// 【取消】worker 里的搜索是同步的，收不到 message，所以打断只能靠主线程
// `terminate()`（组件在重开一局时会这么做），或者让结果过期后被丢弃。
// 两条都做了 —— 见 GomokuLocal.tsx 的 requestSeq / resetAiWorker。
//
// 【打包】`new Worker(new URL('./gomoku-ai.worker.ts', import.meta.url))` 是
// Next 15 原生支持的写法，不需要动 next.config。import 一律走相对路径：
// worker 的打包链路对 tsconfig 别名的解析不如主包可靠。
// ─────────────────────────────────────────────────────────────────────────────

import { GomokuBoard } from '../../lib/gomoku-rules';
import { findBestMove } from '../../lib/gomoku-ai';
import type { AiRequest, AiResponse } from './gomoku-ai-protocol';

// worker 全局的 `self` 在 tsconfig 的 dom lib 下被当成 Window（签名对不上），
// 这里收窄成实际用到的那两个成员，避免为一个文件去引 webworker lib 而与 dom 冲突。
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null;
  postMessage: (msg: AiResponse) => void;
};

ctx.onmessage = (e: MessageEvent<AiRequest>): void => {
  const { id, moves, player, difficulty } = e.data;

  const board = new GomokuBoard();
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    board.placeStone(m.row, m.col, m.player);
  }

  const best = findBestMove(board, player, { difficulty });

  const reply: AiResponse = { id, row: best.row, col: best.col };
  ctx.postMessage(reply);
};
