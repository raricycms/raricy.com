// ─────────────────────────────────────────────────────────────────────────────
// gomoku-ai-protocol.ts — 单机五子棋「主线程 ↔ AI Worker」之间的消息契约。
//
// 【为什么单独一个文件】两边都要用这套类型。直接让组件 `import type` worker
// 文件也能work（类型在编译期会被抹掉），但那取决于打包器的 tree-shaking 行为，
// 一旦哪天它把 worker 也打进主包，就会在浏览器里执行一段只在 worker 里有意义的
// 代码。拆出来两边都只依赖这个零副作用的模块，没有这个隐患。
//
// 【为什么传着法历史而不是整张棋盘】棋盘是 225 个数字，而历史通常只有几十手。
// 更重要的是历史没有「怎么编码」的歧义 —— worker 直接用 gomoku-rules 的
// `placeStone` 重放一遍，和主线程是同一份代码路径，不会出现两边编码不一致。
// ─────────────────────────────────────────────────────────────────────────────

import type { Difficulty } from '@/lib/gomoku-ai';
import type { Player } from '@/lib/gomoku-rules';

/** 一手棋。与 gomoku-rules 的 `Move` 同形，但刻意不 import 它 —— 见文件头。 */
export interface AiProtocolMove {
  row: number;
  col: number;
  player: Player;
}

export interface AiRequest {
  /** 请求序号。主线程靠它丢弃「局面已经变了」的迟到结果。 */
  id: number;
  moves: AiProtocolMove[];
  /** 该 AI 走的一方。 */
  player: Player;
  difficulty: Difficulty;
}

export interface AiResponse {
  id: number;
  row: number;
  col: number;
}
