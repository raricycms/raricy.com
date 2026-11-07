// 与原引擎相同的 4px 网格、非零环绕规则。只扫描新多边形，避免每帧重算全部领地。
export interface QuandiPoint { x: number; y: number }
const WIDTH = 300, HEIGHT = 150;
// 百分制分母与客户端 `Territory.js` 同一把尺：客户端把「画布面积 × 0.95」当满分 100
// （maxArea，见 public/static/quandi/js/objects/Territory.js），因此服务端分母也取
// 0.95 × 画布面积，并把结果封顶 100。两侧标尺不同源时，无限模式的 60% 胜线在联机与
// 单机之间会差约 5.3%（服务端 60% 全画布 vs 客户端 60% 的 0.95 画布）。
const MAX_SCORE_CELLS = WIDTH * HEIGHT * 0.95;
export class TerritoryGrid {
  private masks = new Map<string, Uint8Array>();
  private counts = new Map<string, number>();
  add(id: string, polygon: readonly QuandiPoint[]) {
    const width = WIDTH, height = HEIGHT;
    let mask = this.masks.get(id);
    if (!mask) { mask = new Uint8Array(width * height); this.masks.set(id, mask); }
    let count = this.counts.get(id) ?? 0;
    for (let row = 0; row < height; row++) {
      const y = row * 4;
      const edges: { x: number; winding: number }[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          edges.push({ x: a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y), winding: b.y > a.y ? 1 : -1 });
        }
      }
      edges.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i < edges.length - 1; i++) {
        winding += edges[i].winding;
        if (!winding) continue;
        const start = Math.max(0, Math.ceil(edges[i].x / 4));
        const end = Math.min(width, Math.ceil(edges[i + 1].x / 4));
        for (let column = start; column < end; column++) {
          const index = row * width + column;
          if (!mask[index]) { mask[index] = 1; count++; }
        }
      }
    }
    this.counts.set(id, count);
  }
  /** 领地百分比：分母 = 画布格数 × 0.95（与客户端同一把尺），封顶 100。 */
  score(id: string) { return Math.min(100, ((this.counts.get(id) ?? 0) / MAX_SCORE_CELLS) * 100); }
  clear() { this.masks.clear(); this.counts.clear(); }
}
