// POST /api/game/chess/rooms/[code]/seat — 坐上空着的那一席（观战台的人点「加入」；已经在另一席上的人点它就是换先）
//
// 【本文件是声明，不是实现】十二个 handler 的实现在 api/game/_shared.ts 的工厂里，
// 五款棋共用同一份 —— 60 个 route.ts 各写一遍的话，改一处（换个限频档、给流加个
// 响应头）要记得改 60 处，忘掉的那几处不会有任何测试转红。
// 这里只声明「哪一款棋」与「哪一条路由」。

import { roomApi } from '@/lib/chess-room';
import { makeTakeSeatHandler } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = makeTakeSeatHandler('chess', roomApi);
