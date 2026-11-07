// 网络、认证与限频统一由本站实时服务处理。引擎只计算一局游戏。
export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 600;

// 出生点（画布比例）。ServerEngine 建玩家、ServerItemManager / ServerSurvivalManager
// 生成道具与 AI 时都要避开出生位置 —— 三处曾各写一份像素字面量，改地图尺寸就会漏改。
export const SPAWN_POINTS = [
    { x: 0.15, y: 0.5 },
    { x: 0.85, y: 0.5 },
    { x: 0.5, y: 0.15 },
    { x: 0.5, y: 0.85 }
];

export default { ANTI_CHEAT: { MAX_INPUT_RATE: 60, SPEED_TOLERANCE: 1.1, MAX_VIOLATIONS: 3, VIOLATION_WINDOW: 10000, ENABLE_SPEED_CHECK: true, ENABLE_BOUNDARY_CHECK: true, ENABLE_INPUT_VALIDATION: true } };
