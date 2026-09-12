// GET /api/game/xiangqi/rooms/[code] — 取全量快照
//
// 【本文件是声明，不是实现】八个 handler 的实现在 api/game/_shared.ts 的工厂里，
// 五款棋共用同一份 —— 40 个 route.ts 各写一遍的话，改一处（换个限频档、给流加个
// 响应头）要记得改 40 处，忘掉的那几处不会有任何测试转红。
// 这里只声明「哪一款棋」与「哪一条路由」。

import { roomApi } from '@/lib/xiangqi-room';
import { makeSnapshotHandler } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeSnapshotHandler('xiangqi', roomApi);
