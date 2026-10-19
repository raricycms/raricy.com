import { TILE, TILES, WORLD_HEIGHT, WORLD_WIDTH } from './protocol';

/**
 * 可通行性与逐步位移 —— 服务端权威世界与客户端本地前推**共用这一份**。
 *
 * 拆出来是为了让浏览器也能 import：`shared/wand2/` 里其余文件用 `./protocol.js`
 * 这种带扩展名的写法（实时服务用 tsc 编译，没问题），但 Next 的 webpack 不会把
 * `./protocol.js` 换回 `.ts`，客户端一引就构建失败。这个模块只用无扩展名的相对
 * import，两边都认；规则本身仍然只有一份，各写一份的话客户端会把自己推进
 * 服务端不认的墙里，然后每次快照都被拽回来。
 */

export function blocked(x: number, y: number, radius = 12): boolean {
  if (x < radius || y < radius || x > WORLD_WIDTH - radius || y > WORLD_HEIGHT - radius) return true;
  for (let row = Math.floor((y - radius) / TILE); row <= Math.floor((y + radius) / TILE); row++) {
    for (let col = Math.floor((x - radius) / TILE); col <= Math.floor((x + radius) / TILE); col++) if (TILES[row]?.[col] === 1) return true;
  }
  return false;
}

/** 按 4px 一步推进，逐步判碰撞：斜向贴墙时不会整段位移一起被否掉。 */
export function move(p: { x: number; y: number }, dx: number, dy: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
  for (let i = 0; i < steps; i++) {
    if (!blocked(p.x + dx / steps, p.y)) p.x += dx / steps;
    if (!blocked(p.x, p.y + dy / steps)) p.y += dy / steps;
  }
}
