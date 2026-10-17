// 与原引擎相同的 4px 网格、非零环绕规则。只扫描新多边形，避免每帧重算全部领地。
export interface QuandiPoint { x: number; y: number }
export class TerritoryGrid {
  private masks = new Map<string, Uint8Array>();
  private counts = new Map<string, number>();
  add(id: string, polygon: readonly QuandiPoint[]) {
    const width = 300, height = 150;
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
  score(id: string) { return (this.counts.get(id) ?? 0) / 450; }
  clear() { this.masks.clear(); this.counts.clear(); }
}
