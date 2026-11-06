/* 手写力导向：均匀网格的局部排斥、边弹簧、中心引力、会话弱引力及速度阻尼。 */
(function (root) {
  "use strict";
  class MemoryPhysics {
    constructor(nodes, edges) {
      this.nodes = nodes;
      this.edges = edges;
      this.alpha = 1;
      this.grid = new Map();
      this.tick = 0;
      this.comparisons = 0;
      this.cellSize = 70;
      this.seed();
    }
    seed() {
      const groups = new Map();
      for (const n of this.nodes) {
        if (!groups.has(n.session)) groups.set(n.session, []);
        groups.get(n.session).push(n);
      }
      const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      const mainRadius = Math.sqrt(sorted[0]?.[1].length || 1) * 13;
      this.groups = [];
      sorted.forEach(([name, list], g) => {
        const radius = Math.max(48, Math.sqrt(list.length) * 13);
        const angle = (g - 1) * 2.399963;
        const orbit = mainRadius + radius + 130 + (g > 6 ? 170 : 0);
        const cx = g ? Math.cos(angle) * orbit : 0;
        const cy = g ? Math.sin(angle) * orbit * 0.68 : 0;
        this.groups.push({ name, x: cx, y: cy, radius, nodes: list });
        list.sort((a, b) => a.created - b.created || a.id - b.id);
        list.forEach((n, i) => {
          const r = radius * Math.sqrt((i + 0.5) / list.length);
          const phi = i * 2.399963;
          n.x = cx + Math.cos(phi) * r; n.y = cy + Math.sin(phi) * r;
          n.vx = 0; n.vy = 0; n.cx = cx; n.cy = cy;
        });
      });
    }
    key(x, y) { return (x + 32768) * 65536 + y + 32768; }
    reheat(amount = 0.45) { this.alpha = Math.max(this.alpha, amount); }
    step() {
      if (this.alpha < 0.008) return false;
      const grid = this.grid;
      grid.clear();
      const cellSize = this.cellSize;
      // 每桶最多 24 个均匀水库样本；拥挤极端情况也不会退化成全量平方复杂度。
      for (const n of this.nodes) {
        if (!n.visible) continue;
        n.gx = Math.floor(n.x / cellSize); n.gy = Math.floor(n.y / cellSize);
        const key = this.key(n.gx, n.gy);
        let cell = grid.get(key);
        if (!cell) { cell = { count: 0, samples: [] }; grid.set(key, cell); }
        cell.count++;
        if (cell.samples.length < 24) cell.samples.push(n);
        else {
          const slot = ((Math.imul(n.id + this.tick, 2654435761) >>> 0) % cell.count);
          if (slot < 24) cell.samples[slot] = n;
        }
      }
      const alpha = this.alpha;
      let comparisons = 0;
      for (const n of this.nodes) {
        if (!n.visible) continue;
        let fx = 0, fy = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(this.key(n.gx + dx, n.gy + dy));
          if (!cell) continue;
          const density = Math.min(4, cell.count / cell.samples.length);
          for (const other of cell.samples) {
            if (other === n) continue;
            comparisons++;
            let x = n.x - other.x, y = n.y - other.y;
            if (x === 0 && y === 0) { x = ((n.id & 1) ? 1 : -1) * 0.5; y = n.id > other.id ? 0.5 : -0.5; }
            const square = x * x + y * y;
            if (square > cellSize * cellSize) continue;
            const force = 24 * density / (square + 36);
            fx += x * force; fy += y * force;
          }
        }
        n.vx += (fx - n.x * 0.00035 + (n.cx - n.x) * 0.00045) * alpha;
        n.vy += (fy - n.y * 0.00035 + (n.cy - n.y) * 0.00045) * alpha;
      }
      for (const e of this.edges) {
        const a = e.a, b = e.b;
        if (!a.visible || !b.visible) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = 30 + (1 - e.weight) * 52;
        const force = (distance - rest) / distance * 0.0045 * alpha;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
      for (const n of this.nodes) {
        if (!n.visible) continue;
        if (n.pinned) { n.vx = n.vy = 0; continue; }
        n.vx = Math.max(-7, Math.min(7, n.vx * 0.79));
        n.vy = Math.max(-7, Math.min(7, n.vy * 0.79));
        n.x = Math.max(-20000, Math.min(20000, n.x + n.vx));
        n.y = Math.max(-20000, Math.min(20000, n.y + n.vy));
      }
      this.alpha *= 0.986;
      this.tick++;
      this.comparisons = comparisons;
      return true;
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = MemoryPhysics;
  else root.MemoryPhysics = MemoryPhysics;
})(typeof window !== "undefined" ? window : globalThis);
