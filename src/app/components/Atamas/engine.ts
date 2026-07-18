// ─────────────────────────────────────────────────────────────────────────────
// ATÅMAS — 核心引擎（几何 / 链式合并 / 特殊加号 / 记分 / 动画调度）
//
// 忠实移植自 Flask 侧 app/static/js/game/atamas/core.js（约 1572 行）。
// 与原实现的差异仅在于：不直接操作 DOM，而是通过 onSnapshot 回调把 UI 快照推给
// React；画布渲染委托给 ./render 的 drawAtamas。所有游戏机制（回合推进、随机
// 生成、链式合并、特殊加号、记分、撤销冷却、动画时序）逐行对齐 core.js。
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_ELEMENTS } from './constants';
import type { RingElement, PendingElement, AtamasUiSnapshot } from './constants';
import { getTranslation, formatTranslation } from './i18n';
import { drawAtamas } from './render';

interface PreviousState {
  elements: RingElement[];
  round: number;
  n: number;
  totalScore: number;
  maxPlate: number;
  pendingElement: PendingElement | null;
  pendingQueue: PendingElement[];
  nextPlusRound: number;
  canRecall: boolean;
  roundsSinceRecall: number;
}

export interface GameState {
  elements: RingElement[];
  pendingElement: PendingElement | null;
  round: number;
  n: number;
  gameOver: boolean;
  animating: boolean;
  nextId: number;
  mergeFlash: number[];
  hoverGapIndex: number;
  nextPlusRound: number;
  totalScore: number;
  maxPlate: number;
  needsRedraw: boolean;
  gameStartTime: string | null;
  canRecall: boolean;
  roundsSinceRecall: number;
  previousState: PreviousState | null;
  pendingQueue: PendingElement[];
}

export interface EngineCallbacks {
  onSnapshot: (snapshot: AtamasUiSnapshot) => void;
}

const TAU = 2 * Math.PI;

export class AtamasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: EngineCallbacks;

  state: GameState;
  private message = '';
  private currentAction = '';
  private gameOverAnimProgress = 0;
  private gameOverAnimationId: number | null = null;
  private loopId: number | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    cb: EngineCallbacks
  ) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.cb = cb;
    this.state = {
      elements: [],
      pendingElement: null,
      round: 1,
      n: 0,
      gameOver: false,
      animating: false,
      nextId: 0,
      mergeFlash: [],
      hoverGapIndex: -1,
      nextPlusRound: 2,
      totalScore: 0,
      maxPlate: 0,
      needsRedraw: true,
      gameStartTime: null,
      canRecall: true,
      roundsSinceRecall: 25,
      previousState: null,
      pendingQueue: [],
    };
  }

  // ── 计时器 / 生命周期 ──────────────────────────────────────────────────────
  private later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.destroyed) return;
      fn();
    }, ms);
    this.timers.add(id);
  }

  destroy(): void {
    this.destroyed = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    if (this.loopId !== null) cancelAnimationFrame(this.loopId);
    if (this.gameOverAnimationId !== null)
      cancelAnimationFrame(this.gameOverAnimationId);
  }

  // ── 消息 / 当前动作 / 快照 ─────────────────────────────────────────────────
  private setMessage(html: string): void {
    this.message = html;
    this.emit();
  }

  private setAction(text: string): void {
    this.currentAction = text;
    this.emit();
  }

  /** 相当于原 core.js 的 updateUI + updateRecallButton：构建快照推给 React。 */
  private emit(): void {
    const s = this.state;

    // updateRecallButton 的副作用：冷却结束时置回 canRecall=true
    const roundsLeft = 25 - s.roundsSinceRecall;
    const cooldownComplete = s.roundsSinceRecall >= 25;
    const hasStateToRecall = s.previousState !== null;
    if (cooldownComplete && !s.canRecall) s.canRecall = true;

    let recall: AtamasUiSnapshot['recall'];
    if (cooldownComplete && hasStateToRecall) {
      recall = { disabled: false, text: getTranslation('recall') || '↩ Recall', title: 'Recall last move' };
    } else if (cooldownComplete) {
      recall = { disabled: true, text: `↩ ${roundsLeft}`, title: 'Place an element first' };
    } else {
      recall = { disabled: true, text: `↩ ${roundsLeft}`, title: formatTranslation('recallCooldown', { n: roundsLeft }) };
    }

    const preview: (PendingElement | null)[] = [0, 1, 2].map((i) =>
      s.pendingQueue.length > i ? s.pendingQueue[i] : null
    );

    this.cb.onSnapshot({
      score: s.totalScore,
      maxPlate: s.maxPlate,
      elementCount: s.elements.length,
      preview,
      recall,
      message: this.message,
      currentAction: this.currentAction,
    });
  }

  /** 对齐 updateUI：根据 pendingElement 刷新 currentAction 文案后 emit。 */
  private updateUI(): void {
    const s = this.state;
    if (s.pendingElement) {
      this.currentAction =
        s.pendingElement.type === 'plus'
          ? s.pendingElement.isBlackGolden
            ? getTranslation('placeBlackPlus')
            : getTranslation('placePlus')
          : getTranslation('placeNumber');
    } else {
      this.currentAction = getTranslation('waiting');
    }
    this.emit();
  }

  private updateCurrentActionText(): void {
    const s = this.state;
    if (s.pendingElement) {
      this.currentAction =
        s.pendingElement.type === 'number'
          ? getTranslation('placeNumber')
          : s.pendingElement.isBlackGolden
            ? getTranslation('placeBlackPlus')
            : getTranslation('placePlus');
      this.emit();
    }
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  initGame(): void {
    const s = this.state;
    s.elements = [];
    // 初始 6 个随机数字（1 或 2）
    for (let i = 0; i < 6; i++) {
      s.elements.push({
        type: 'number',
        value: Math.random() < 0.6 ? 1 : 2,
        id: s.nextId++,
        angle: (i / 6) * TAU - Math.PI / 2,
      });
    }
    s.pendingElement = null;
    s.round = 1;
    s.n = 0;
    s.gameOver = false;
    s.animating = false;
    s.mergeFlash = [];
    s.hoverGapIndex = -1;
    s.nextPlusRound = Math.floor(Math.random() * 7) + 2; // 2-8
    s.totalScore = 0;
    s.maxPlate = 0;
    s.gameStartTime = new Date().toISOString();
    s.canRecall = true;
    s.roundsSinceRecall = 25;
    s.previousState = null;
    s.pendingQueue = [];
    this.fillPendingQueue();

    this.updateUI();
    s.needsRedraw = true;
    this.message = getTranslation('clickRingArea');
    this.currentAction = getTranslation('placeNumber');
    this.emit();
  }

  // ── 待放置元素生成 ────────────────────────────────────────────────────────
  private generateElementForRound(forRound: number): PendingElement {
    const n = Math.floor((forRound - 1) / 50);
    const minVal = Math.max(1, n - 2);
    const maxVal = n + 2;
    const range = maxVal - minVal + 1;
    const value = minVal + Math.floor(Math.random() * range);
    return { type: 'number', value, forRound };
  }

  private generateNextElement(): PendingElement {
    const s = this.state;
    const n = Math.floor((s.round - 1) / 50);
    const minVal = Math.max(1, n - 2);
    const maxVal = n + 2;
    const range = maxVal - minVal + 1;
    const value = minVal + Math.floor(Math.random() * range);

    if (s.round >= s.nextPlusRound) {
      const isBlackGolden = Math.random() < 0.1;
      s.nextPlusRound = s.round + Math.floor(Math.random() * 7) + 2;
      return { type: 'plus', value: null, isBlackGolden };
    }
    return { type: 'number', value };
  }

  /** 填充待放置队列（维持 5 个：中心 1 + 队列 4，供 3 个预览）。 */
  private fillPendingQueue(): void {
    const s = this.state;
    let nextRound = s.round;
    while (s.pendingQueue.length < 5) {
      if (nextRound >= s.nextPlusRound) {
        const isBlackGolden = Math.random() < 0.1;
        s.pendingQueue.push({ type: 'plus', value: null, isBlackGolden });
        s.nextPlusRound = nextRound + Math.floor(Math.random() * 7) + 2;
      } else {
        s.pendingQueue.push(this.generateElementForRound(nextRound));
      }
      nextRound++;
    }
    if (!s.pendingElement) {
      s.pendingElement = s.pendingQueue.shift() ?? null;
      this.updateCurrentActionText();
    }
    s.needsRedraw = true;
  }

  private getNextFromQueue(): void {
    const s = this.state;
    if (s.pendingQueue.length > 0) {
      s.pendingElement = s.pendingQueue.shift() ?? null;
    } else {
      s.pendingElement = this.generateNextElement();
    }
    this.fillPendingQueue();
    s.needsRedraw = true;
    this.updateCurrentActionText();
    this.emit();
  }

  // ── 几何 ──────────────────────────────────────────────────────────────────
  private redistributeElements(): void {
    const s = this.state;
    const count = s.elements.length;
    if (count === 0) return;
    const step = TAU / count;
    const startAngle = -Math.PI / 2;
    s.elements.forEach((el, index) => {
      el.angle = startAngle + index * step;
    });
  }

  private calculateTargetAngle(gapIndex: number, currentLen: number): number {
    const step = TAU / (currentLen + 1);
    const startAngle = -Math.PI / 2;
    return startAngle + gapIndex * step;
  }

  /** 依据点击角度判定落在哪个间隙（对齐 getGapIndex）。 */
  private getGapIndex(clickAngle: number): number {
    const s = this.state;
    const len = s.elements.length;
    if (len === 0) return 0;
    if (len === 1) return 1;

    let targetAngle = clickAngle % TAU;
    if (targetAngle < 0) targetAngle += TAU;

    const normalizedAngles = s.elements.map((el) => {
      let angle = el.angle % TAU;
      if (angle < 0) angle += TAU;
      return angle;
    });

    for (let i = 0; i < len; i++) {
      const currentAngle = normalizedAngles[i];
      const nextAngle = normalizedAngles[(i + 1) % len];

      let lowerBound: number;
      let upperBound: number;

      if (nextAngle > currentAngle) {
        lowerBound = currentAngle;
        upperBound = nextAngle;
      } else {
        // 间隙跨越 0
        if (targetAngle >= currentAngle || targetAngle <= nextAngle) {
          return i + 1;
        }
        continue;
      }

      if (targetAngle >= lowerBound && targetAngle <= upperBound) {
        return i + 1;
      }
    }
    return len;
  }

  // ── 游戏结束 ──────────────────────────────────────────────────────────────
  private checkGameOver(): boolean {
    const s = this.state;
    if (s.gameOver) return true;

    if (s.elements.length >= MAX_ELEMENTS) {
      const hasPlusMerge = this.checkPlusMerge();
      if (!hasPlusMerge) {
        s.gameOver = true;
        s.pendingElement = null;
        this.message = `💥 ${getTranslation('gameOver')}! ${getTranslation('diskFull')}<br>🏆 ${getTranslation('score')}: ${s.totalScore} | ${getTranslation('maxPlate')}: ${s.maxPlate}`;
        this.currentAction = getTranslation('gameOver');
        this.startGameOverAnimation();
        this.emit();
        return true;
      }
    }
    return false;
  }

  // ── 特殊加号：普通加号需两侧同值，黑金加号可合并任意两数 ────────────────────
  private checkPlusMerge(): boolean {
    const s = this.state;
    const len = s.elements.length;
    if (len < 3) return false;

    const plusIndices: number[] = [];
    s.elements.forEach((el, idx) => {
      if (el.type === 'plus') plusIndices.push(idx);
    });

    for (const idx of plusIndices) {
      const leftIdx = (idx - 1 + len) % len;
      const rightIdx = (idx + 1) % len;
      const left = s.elements[leftIdx];
      const right = s.elements[rightIdx];
      const plus = s.elements[idx];

      if (left.type === 'number' && right.type === 'number') {
        if (plus.isBlackGolden || left.value === right.value) {
          this.executePlusMerge(idx, leftIdx, rightIdx);
          return true;
        }
      }
    }
    return false;
  }

  // 加号触发的合并：取两数较大者 +1，计分为两数之和
  private executePlusMerge(plusIdx: number, leftIdx: number, rightIdx: number): void {
    const s = this.state;
    const left = s.elements[leftIdx];
    const right = s.elements[rightIdx];
    const newVal = Math.max(left.value ?? 0, right.value ?? 0) + 1;

    s.totalScore += (left.value ?? 0) + (right.value ?? 0);
    if (newVal > s.maxPlate) s.maxPlate = newVal;

    // 从后往前删除加号与两侧数字
    const indices = [plusIdx, leftIdx, rightIdx].sort((a, b) => b - a);
    for (const idx of indices) s.elements.splice(idx, 1);

    const insertPos = Math.min(leftIdx, rightIdx);
    const len = s.elements.length;
    const step = TAU / len;
    const startAngle = -Math.PI / 2;
    const targetAngle = startAngle + insertPos * step;

    const newElement: RingElement = {
      type: 'number',
      value: newVal,
      id: s.nextId++,
      angle: targetAngle,
      isAnimating: false,
      animProgress: 0,
      newlyFormed: true,
    };
    s.elements.splice(insertPos, 0, newElement);

    const nlen = s.elements.length;
    s.mergeFlash = [
      (insertPos - 1 + nlen) % nlen,
      insertPos,
      (insertPos + 1) % nlen,
    ];

    const oldAngles = s.elements.map((el) => el.angle);
    this.redistributeElements();
    s.elements.forEach((el, idx) => {
      if (idx !== insertPos) {
        el.startAngle = oldAngles[idx];
        el.targetAngle = s.elements[idx].angle;
        el.isAnimating = true;
        el.animProgress = 0;
        el.angle = el.startAngle;
      }
    });

    s.round++;
    s.animating = true;
    this.animateRedistribution();

    this.later(() => {
      s.mergeFlash = [];
      if (this.checkGameOver()) return;
      this.performChainMergeStep();
    }, 500);
  }

  // 逐步链式合并：一次一步（回文式 left==right 且中心为数字 → 中心 +1）
  private performChainMergeStep(): void {
    const s = this.state;
    let centerIdx = -1;
    for (let i = 0; i < s.elements.length; i++) {
      if (s.elements[i].newlyFormed) {
        centerIdx = i;
        break;
      }
    }

    if (centerIdx === -1) {
      this.later(() => {
        if (this.checkGameOver()) return;
        const hasMore = this.checkPlusMerge();
        if (!hasMore) {
          s.animating = false;
          this.updateUI();
          s.needsRedraw = true;
          this.setMessage(formatTranslation('mergeComplete', { round: s.round - 1 }));
        }
      }, 300);
      return;
    }

    const len = s.elements.length;
    if (len < 3) {
      s.elements.forEach((el) => (el.newlyFormed = false));
      this.later(() => {
        if (this.checkGameOver()) return;
        const hasMore = this.checkPlusMerge();
        if (!hasMore) {
          s.animating = false;
          this.updateUI();
          s.needsRedraw = true;
          this.setMessage(formatTranslation('mergeComplete', { round: s.round - 1 }));
          if (s.elements.length < MAX_ELEMENTS) this.getNextFromQueue();
        }
      }, 300);
      return;
    }

    const leftIdx = (centerIdx - 1 + len) % len;
    const rightIdx = (centerIdx + 1) % len;
    const left = s.elements[leftIdx];
    const center = s.elements[centerIdx];
    const right = s.elements[rightIdx];

    if (
      left.type === 'number' &&
      right.type === 'number' &&
      left.value === right.value &&
      center.type === 'number'
    ) {
      const newVal = (center.value ?? 0) + 1;
      s.totalScore += (left.value ?? 0) + (center.value ?? 0) + (right.value ?? 0);
      if (newVal > s.maxPlate) s.maxPlate = newVal;

      const indices = [leftIdx, centerIdx, rightIdx].sort((a, b) => b - a);
      for (const idx of indices) s.elements.splice(idx, 1);

      const insertPos = Math.min(leftIdx, centerIdx, rightIdx);
      const newLen = s.elements.length;
      const step = TAU / newLen;
      const startAngle = -Math.PI / 2;
      const targetAngle = startAngle + insertPos * step;

      const newEl: RingElement = {
        type: 'number',
        value: newVal,
        id: s.nextId++,
        angle: targetAngle,
        isAnimating: false,
        animProgress: 0,
        newlyFormed: true,
      };
      s.elements.splice(insertPos, 0, newEl);

      const flashLen = s.elements.length;
      s.mergeFlash = [
        (insertPos - 1 + flashLen) % flashLen,
        insertPos,
        (insertPos + 1) % flashLen,
      ];

      const oldAngles = s.elements.map((el) => el.angle);
      this.redistributeElements();
      s.elements.forEach((el, idx) => {
        if (idx !== insertPos) {
          el.startAngle = oldAngles[idx];
          el.targetAngle = s.elements[idx].angle;
          el.isAnimating = true;
          el.animProgress = 0;
          el.angle = el.startAngle;
        }
      });

      s.animating = true;
      this.animateRedistribution();

      this.later(() => {
        s.mergeFlash = [];
        if (this.checkGameOver()) return;
        this.performChainMergeStep();
      }, 400);
    } else {
      s.elements.forEach((el) => (el.newlyFormed = false));
      this.later(() => {
        if (this.checkGameOver()) return;
        const hasMore = this.checkPlusMerge();
        if (!hasMore) {
          s.animating = false;
          this.updateUI();
          s.needsRedraw = true;
          this.setMessage(formatTranslation('mergeComplete', { round: s.round - 1 }));
          if (s.elements.length < MAX_ELEMENTS) this.getNextFromQueue();
        }
      }, 300);
    }
  }

  // ── 放置元素 ──────────────────────────────────────────────────────────────
  private placeElementFromCenter(gapIndex: number): boolean {
    const s = this.state;
    if (s.gameOver || s.animating) return false;
    if (!s.pendingElement) {
      this.setMessage(getTranslation('noElementWaiting'));
      return false;
    }

    const len = s.elements.length;
    if (len >= MAX_ELEMENTS + 1) {
      this.checkGameOver();
      return false;
    }

    // 放置前保存快照（供撤销）
    s.previousState = {
      elements: JSON.parse(JSON.stringify(s.elements)),
      round: s.round,
      n: s.n,
      totalScore: s.totalScore,
      maxPlate: s.maxPlate,
      pendingElement: s.pendingElement ? JSON.parse(JSON.stringify(s.pendingElement)) : null,
      pendingQueue: JSON.parse(JSON.stringify(s.pendingQueue)),
      nextPlusRound: s.nextPlusRound,
      canRecall: s.canRecall,
      roundsSinceRecall: s.roundsSinceRecall,
    };

    const pending = s.pendingElement;
    const targetAngle = this.calculateTargetAngle(gapIndex, len);

    const newElement: RingElement = {
      type: pending.type,
      value: pending.value,
      id: s.nextId++,
      angle: 0,
      isAnimating: true,
      animProgress: 0,
      startAngle: 0,
      targetAngle,
      isNew: true,
      isBlackGolden: pending.isBlackGolden || false,
    };

    const insertPos = gapIndex >= len ? len : gapIndex;
    if (insertPos >= len) s.elements.push(newElement);
    else s.elements.splice(insertPos, 0, newElement);

    const oldAngles = s.elements.map((el) => el.angle);
    this.redistributeElements();
    s.elements.forEach((el, idx) => {
      if (idx !== insertPos) {
        el.startAngle = oldAngles[idx];
        el.targetAngle = s.elements[idx].angle;
        el.isAnimating = true;
        el.animProgress = 0;
        el.angle = el.startAngle;
        el.isNew = false;
      }
    });

    s.pendingElement = null;
    s.round++;
    s.roundsSinceRecall++;
    s.animating = true;
    this.animateRedistribution();

    this.later(() => {
      const hasMerge = this.checkPlusMerge();
      if (!hasMerge) {
        s.animating = false;
        this.updateUI();
        s.needsRedraw = true;

        if (newElement.type === 'number') {
          this.setMessage(
            formatTranslation('numberPlaced', { pos: insertPos + 1, round: s.round - 1 })
          );
          if (s.elements.length < MAX_ELEMENTS) this.getNextFromQueue();
        } else {
          const plusType = newElement.isBlackGolden ? '🌟 Black+' : '➕ Plus';
          this.setMessage(formatTranslation('plusPlaced', { type: plusType }));
          if (!this.checkPlusMerge()) {
            this.later(() => {
              if (s.elements.length < MAX_ELEMENTS) this.getNextFromQueue();
            }, 500);
          }
        }
      }
    }, 600);

    this.checkGameOver();
    this.updateUI();
    return true;
  }

  // ── 撤销上一步（25 回合冷却）────────────────────────────────────────────────
  recall(): void {
    const s = this.state;
    if (!s.canRecall) {
      this.setMessage(getTranslation('recallNotAvailableYet'));
      return;
    }
    if (!s.previousState) {
      this.setMessage(getTranslation('noMoveToRecall'));
      return;
    }
    if (s.animating) {
      this.setMessage(getTranslation('cannotRecallDuringAnimation'));
      return;
    }
    if (s.gameOver) {
      this.setMessage(getTranslation('gameOver'));
      return;
    }

    const prev = s.previousState;
    s.elements = prev.elements;
    s.round = prev.round;
    s.n = prev.n;
    s.totalScore = prev.totalScore;
    s.maxPlate = prev.maxPlate;
    s.pendingElement = prev.pendingElement;
    s.pendingQueue = prev.pendingQueue;
    s.nextPlusRound = prev.nextPlusRound;
    s.canRecall = false;
    s.roundsSinceRecall = 0;
    s.previousState = null;

    this.updateUI();
    s.needsRedraw = true;
    this.message = getTranslation('moveRecalled');
    if (s.pendingElement) {
      this.currentAction =
        s.pendingElement.type === 'number'
          ? getTranslation('placeNumber')
          : s.pendingElement.isBlackGolden
            ? getTranslation('placeBlackPlus')
            : getTranslation('placePlus');
    }
    this.emit();
  }

  // ── 指针交互 ──────────────────────────────────────────────────────────────
  private toCanvasPoint(clientX: number, clientY: number): { dx: number; dy: number; dist: number; radius: number } {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = canvasX - cx;
    const dy = canvasY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radius = canvas.width * 0.38;
    return { dx, dy, dist, radius };
  }

  handleClick(clientX: number, clientY: number): void {
    const s = this.state;
    if (s.gameOver || s.animating) {
      if (s.gameOver)
        this.setMessage(`⛔ ${getTranslation('gameOver')}, ${getTranslation('clickRingArea')}`);
      return;
    }
    if (!s.pendingElement) {
      this.setMessage(getTranslation('waiting'));
      return;
    }

    const { dx, dy, dist, radius } = this.toCanvasPoint(clientX, clientY);
    const innerRadius = radius * 0.6;
    const outerRadius = radius * 1.15;
    if (dist < innerRadius || dist > outerRadius) {
      this.setMessage(getTranslation('clickOnRing'));
      return;
    }

    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TAU;

    const len = s.elements.length;
    if (len === 0) {
      const pending = s.pendingElement;
      s.elements.push({
        type: pending.type,
        value: pending.value,
        id: s.nextId++,
        angle: 0,
        isAnimating: false,
        animProgress: 0,
      });
      s.pendingElement = null;
      this.redistributeElements();
      s.round++;
      s.roundsSinceRecall++;
      this.updateUI();
      s.needsRedraw = true;
      this.message = getTranslation('firstElementPlaced');
      this.getNextFromQueue();
      return;
    }

    const gapIndex = this.getGapIndex(angle);
    this.placeElementFromCenter(gapIndex);
  }

  handleMouseMove(clientX: number, clientY: number): void {
    const s = this.state;
    if (s.gameOver || s.animating || !s.pendingElement) {
      s.hoverGapIndex = -1;
      return;
    }

    const { dx, dy, dist, radius } = this.toCanvasPoint(clientX, clientY);
    const innerRadius = radius * 0.6;
    const outerRadius = radius * 1.15;
    if (dist < innerRadius || dist > outerRadius) {
      s.hoverGapIndex = -1;
      s.needsRedraw = true;
      return;
    }

    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TAU;

    const len = s.elements.length;
    if (len === 0) {
      s.hoverGapIndex = 0;
      s.needsRedraw = true;
      return;
    }
    s.hoverGapIndex = this.getGapIndex(angle);
    s.needsRedraw = true;
  }

  handleMouseLeave(): void {
    this.state.hoverGapIndex = -1;
    this.state.needsRedraw = true;
  }

  // ── 动画 ──────────────────────────────────────────────────────────────────
  private animateRedistribution = (): void => {
    const s = this.state;
    let allDone = true;

    s.elements.forEach((el) => {
      if (el.isAnimating) {
        allDone = false;
        el.animProgress = (el.animProgress ?? 0) + 0.12;
        if (el.animProgress >= 1) {
          el.animProgress = 1;
          el.angle = el.targetAngle ?? el.angle;
          el.isAnimating = false;
          el.startAngle = null;
          el.isNew = false;
        } else {
          const progress = 1 - Math.pow(1 - el.animProgress, 3);
          if (el.isNew) {
            el.angle = (el.targetAngle ?? 0) * progress;
          } else {
            let diff = (el.targetAngle ?? 0) - (el.startAngle ?? 0);
            while (diff > Math.PI) diff -= TAU;
            while (diff < -Math.PI) diff += TAU;
            el.angle = (el.startAngle ?? 0) + diff * progress;
          }
        }
      }
    });

    s.needsRedraw = true;
    if (!allDone) {
      requestAnimationFrame(this.animateRedistribution);
    } else {
      s.animating = false;
    }
  };

  // ── 游戏结束动画 ──────────────────────────────────────────────────────────
  private startGameOverAnimation(): void {
    this.gameOverAnimProgress = 0;
    if (this.gameOverAnimationId !== null) cancelAnimationFrame(this.gameOverAnimationId);
    this.animateGameOver();
  }

  private animateGameOver = (): void => {
    this.gameOverAnimProgress += 0.02;
    if (this.gameOverAnimProgress <= 1) {
      this.state.needsRedraw = true;
      this.gameOverAnimationId = requestAnimationFrame(this.animateGameOver);
    }
  };

  // ── 重置 ──────────────────────────────────────────────────────────────────
  reset(): void {
    const s = this.state;
    s.nextId = 0;
    s.animating = false;
    s.mergeFlash = [];
    s.hoverGapIndex = -1;
    this.gameOverAnimProgress = 0;
    if (this.gameOverAnimationId !== null) cancelAnimationFrame(this.gameOverAnimationId);
    this.initGame();
    s.needsRedraw = true;
    this.updateUI();
    this.message = getTranslation('gameReset');
    this.currentAction = getTranslation('placeNumber');
    this.emit();
  }

  // ── 渲染循环 ──────────────────────────────────────────────────────────────
  private render(): void {
    drawAtamas(this.ctx, this.canvas, this.state, {
      gameOverAnimProgress: this.gameOverAnimProgress,
      getTranslation,
    });
  }

  private loop = (): void => {
    const s = this.state;
    if (s.needsRedraw || s.pendingElement) {
      this.render();
      s.needsRedraw = false;
    }
    this.loopId = requestAnimationFrame(this.loop);
  };

  start(): void {
    this.loop();
  }

  /** 语言 / 主题变化后请求重绘（画布含 placeMe 文案）。 */
  requestRedraw(): void {
    this.state.needsRedraw = true;
  }
}
