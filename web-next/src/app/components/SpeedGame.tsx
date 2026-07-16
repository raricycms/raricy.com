'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 速度接龙（Speed）— 从 Flask 侧 app/static/js/game/speed.js 忠实移植到 React
// 客户端组件。纯前端逻辑，无服务端依赖。本地双人竞速纸牌。
//
// 规则要点（与原实现一一对应）：
//   • 52 张牌按红（♥♦）/ 黑（♠♣）分成两副：玩家1 执红、玩家2 执黑，各 26 张。
//   • 每人手牌上限 MAX_HAND_SIZE=4，其余进各自的抽牌堆；各自翻一张作为中央堆底。
//   • 出牌：手牌与目标中央堆顶点数相邻（±1，且 A↔K 环绕）即可打出。
//   • 补牌：手牌 < 4 且抽牌堆非空时可补一张。
//   • 竞速判定：双方都无法行动（既不能出牌也不能补牌）时进入僵局，
//     提示「按空格翻牌」——各自从抽牌堆（空则从手牌随机）翻一张压到中央堆。
//   • 胜负：某玩家手牌与抽牌堆同时清空即获胜。
//
// 双人键盘交互（与原实现一致）：
//   玩家1（下方，红）：选牌 Q/W/E/R，补牌 A，出至左堆 S、右堆 D。
//   玩家2（上方，黑）：选牌 U/I/O/P，补牌 J，出至左堆 K、右堆 L。
//   公共：僵局时空格翻牌。
//
// 原实现为全局可变数组 + 命令式 DOM 操作；此处将牌局状态存于 ref，
// 用版本号触发 React 重绘（读 ref 声明式渲染），逐一对齐原逻辑。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── 常量（对齐 speed.js 顶部）───────────────────────────────────────────────
const SUITS = ['♥', '♦', '♠', '♣'] as const;
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
const MAX_HAND_SIZE = 4;

type Card = { suit: string; value: string; id: string; isNew?: boolean };
type Selection = { player: 1 | 2; index: number; card: Card } | null;

// ─── 纯函数（对齐 speed.js 的无状态工具）─────────────────────────────────────
function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

function getCardValue(val: string): number {
  if (val === 'A') return 1;
  if (val === 'J') return 11;
  if (val === 'Q') return 12;
  if (val === 'K') return 13;
  return parseInt(val, 10);
}

function isPlayable(card: Card | undefined, topOfPile: Card | undefined): boolean {
  if (!card || !topOfPile) return false;
  const cardVal = getCardValue(card.value);
  const pileVal = getCardValue(topOfPile.value);
  return (
    Math.abs(cardVal - pileVal) === 1 ||
    (cardVal === 1 && pileVal === 13) ||
    (cardVal === 13 && pileVal === 1)
  );
}

function canPlayFromHand(hand: Card[], b1: Card[], b2: Card[]): boolean {
  const top1 = b1[b1.length - 1];
  const top2 = b2[b2.length - 1];
  return hand.some((card) => isPlayable(card, top1) || isPlayable(card, top2));
}

// ─── 组件（对齐 speed.js 的 IIFE 状态机）─────────────────────────────────────
export default function SpeedGame() {
  // 牌局状态（命令式，存 ref 以对齐原全局可变数组）
  const p1DrawRef = useRef<Card[]>([]);
  const p1HandRef = useRef<Card[]>([]);
  const p2DrawRef = useRef<Card[]>([]);
  const p2HandRef = useRef<Card[]>([]);
  const build1Ref = useRef<Card[]>([]);
  const build2Ref = useRef<Card[]>([]);

  const gameInProgressRef = useRef<boolean>(true);
  const isSpeedAllowedRef = useRef<boolean>(false);
  const p1SelectedRef = useRef<Selection>(null);
  const p2SelectedRef = useRef<Selection>(null);
  const winnerRef = useRef<string>('');

  // 出牌 / 翻牌时中央堆的一次性动画标记（对齐 speed-pile--playing）
  const [playing1, setPlaying1] = useState(false);
  const [playing2, setPlaying2] = useState(false);

  // 版本号：触发声明式重绘（JSX 读取上面各 ref）
  const [, setVersion] = useState(0);
  const forceRender = useCallback(() => setVersion((v) => v + 1), []);

  // ── canPlayerAct / checkSpeedCondition（对齐同名函数）────────────────────
  const canPlayerAct = useCallback((hand: Card[], drawPile: Card[]): boolean => {
    if (canPlayFromHand(hand, build1Ref.current, build2Ref.current)) return true;
    if (hand.length < MAX_HAND_SIZE && drawPile.length > 0) return true;
    return false;
  }, []);

  const checkSpeedCondition = useCallback(() => {
    if (
      !canPlayerAct(p1HandRef.current, p1DrawRef.current) &&
      !canPlayerAct(p2HandRef.current, p2DrawRef.current) &&
      gameInProgressRef.current
    ) {
      isSpeedAllowedRef.current = true;
    } else {
      isSpeedAllowedRef.current = false;
    }
  }, [canPlayerAct]);

  // ── checkWinner（对齐同名函数）───────────────────────────────────────────
  const checkWinner = useCallback(() => {
    if (p1HandRef.current.length === 0 && p1DrawRef.current.length === 0) {
      winnerRef.current = '玩家1 获胜!';
      gameInProgressRef.current = false;
    } else if (p2HandRef.current.length === 0 && p2DrawRef.current.length === 0) {
      winnerRef.current = '玩家2 获胜!';
      gameInProgressRef.current = false;
    }
  }, []);

  // ── render()（对齐同名函数）：重算派生态并触发重绘 ───────────────────────
  const render = useCallback(() => {
    checkWinner();
    checkSpeedCondition();
    forceRender();
  }, [checkWinner, checkSpeedCondition, forceRender]);

  // ── dealCards（对齐同名函数）─────────────────────────────────────────────
  const dealCards = useCallback(() => {
    const deck: Card[] = [];
    SUITS.forEach((s) => {
      VALUES.forEach((v) => deck.push({ suit: s, value: v, id: `${s}${v}` }));
    });

    const redDeck = shuffle(deck.filter((c) => c.suit === '♥' || c.suit === '♦'));
    const blackDeck = shuffle(deck.filter((c) => c.suit === '♠' || c.suit === '♣'));

    p1HandRef.current = redDeck.slice(0, MAX_HAND_SIZE);
    p1DrawRef.current = redDeck.slice(MAX_HAND_SIZE);
    p2HandRef.current = blackDeck.slice(0, MAX_HAND_SIZE);
    p2DrawRef.current = blackDeck.slice(MAX_HAND_SIZE);

    build1Ref.current = [p1DrawRef.current.pop() as Card];
    build2Ref.current = [p2DrawRef.current.pop() as Card];
  }, []);

  // ── 中央堆一次性动画（对齐 renderBuildPile(..., true)）────────────────────
  const triggerPileAnim = useCallback((pileNum: 1 | 2) => {
    if (pileNum === 1) {
      setPlaying1(true);
      window.setTimeout(() => setPlaying1(false), 300);
    } else {
      setPlaying2(true);
      window.setTimeout(() => setPlaying2(false), 300);
    }
  }, []);

  // ── drawCard（对齐同名函数）──────────────────────────────────────────────
  const drawCard = useCallback((hand: Card[], drawPile: Card[]) => {
    if (drawPile.length > 0 && hand.length < MAX_HAND_SIZE) {
      const newCard = drawPile.pop() as Card;
      newCard.isNew = true;
      hand.push(newCard);
    }
  }, []);

  // ── playSelectedCard（对齐同名函数）──────────────────────────────────────
  const playSelectedCard = useCallback(
    (selectionInfo: Selection, buildPileNum: 1 | 2) => {
      if (!selectionInfo) return;
      const { player, index, card } = selectionInfo;
      const targetBuildPile = buildPileNum === 1 ? build1Ref.current : build2Ref.current;
      const hand = player === 1 ? p1HandRef.current : p2HandRef.current;

      if (isPlayable(card, targetBuildPile[targetBuildPile.length - 1])) {
        targetBuildPile.push(hand.splice(index, 1)[0]);
        if (player === 1) p1SelectedRef.current = null;
        else p2SelectedRef.current = null;
        triggerPileAnim(buildPileNum);
        render();
      }
    },
    [triggerPileAnim, render]
  );

  // ── flipFromDrawPiles（对齐同名函数）─────────────────────────────────────
  const flipFromDrawPiles = useCallback(() => {
    if (!gameInProgressRef.current || !isSpeedAllowedRef.current) return;

    if (p1DrawRef.current.length > 0) {
      build1Ref.current.push(p1DrawRef.current.pop() as Card);
    } else if (p1HandRef.current.length > 0) {
      const randomIndex = Math.floor(Math.random() * p1HandRef.current.length);
      build1Ref.current.push(p1HandRef.current.splice(randomIndex, 1)[0]);
      if (p1SelectedRef.current && p1SelectedRef.current.index === randomIndex) {
        p1SelectedRef.current = null;
      }
    }

    if (p2DrawRef.current.length > 0) {
      build2Ref.current.push(p2DrawRef.current.pop() as Card);
    } else if (p2HandRef.current.length > 0) {
      const randomIndex2 = Math.floor(Math.random() * p2HandRef.current.length);
      build2Ref.current.push(p2HandRef.current.splice(randomIndex2, 1)[0]);
      if (p2SelectedRef.current && p2SelectedRef.current.index === randomIndex2) {
        p2SelectedRef.current = null;
      }
    }

    triggerPileAnim(1);
    triggerPileAnim(2);
    render();
  }, [triggerPileAnim, render]);

  // ── handleKeyDown（对齐同名函数）─────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!gameInProgressRef.current) return;
      const key = e.key.toLowerCase();
      const p1SelectKeys = ['q', 'w', 'e', 'r'];
      const p2SelectKeys = ['u', 'i', 'o', 'p'];

      const p1Index = p1SelectKeys.indexOf(key);
      if (p1Index !== -1 && p1Index < p1HandRef.current.length) {
        p1SelectedRef.current = { player: 1, index: p1Index, card: p1HandRef.current[p1Index] };
        render();
        return;
      }

      const p2Index = p2SelectKeys.indexOf(key);
      if (p2Index !== -1 && p2Index < p2HandRef.current.length) {
        p2SelectedRef.current = { player: 2, index: p2Index, card: p2HandRef.current[p2Index] };
        render();
        return;
      }

      if (key === 's' || key === 'd') {
        playSelectedCard(p1SelectedRef.current, key === 's' ? 1 : 2);
      } else if (key === 'k' || key === 'l') {
        playSelectedCard(p2SelectedRef.current, key === 'k' ? 1 : 2);
      }

      if (key === 'a') {
        drawCard(p1HandRef.current, p1DrawRef.current);
        render();
      }
      if (key === 'j') {
        drawCard(p2HandRef.current, p2DrawRef.current);
        render();
      }
      if (e.code === 'Space') {
        e.preventDefault();
        flipFromDrawPiles();
      }
    },
    [playSelectedCard, drawCard, flipFromDrawPiles, render]
  );

  // ── startGame（对齐同名函数）─────────────────────────────────────────────
  const startGame = useCallback(() => {
    gameInProgressRef.current = true;
    isSpeedAllowedRef.current = false;
    winnerRef.current = '';
    p1SelectedRef.current = null;
    p2SelectedRef.current = null;
    build1Ref.current = [];
    build2Ref.current = [];
    dealCards();
    render();
  }, [dealCards, render]);

  // 挂载：开局 + 全局键盘监听（对齐 startGame() + window keydown）
  useEffect(() => {
    startGame();
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次提交后清除本轮 isNew 标记（对齐 renderHand 内 `delete card.isNew`）。
  // 动画类已在挂载时触发，此处清标记不再触发可见重绘。
  useEffect(() => {
    [p1HandRef, p2HandRef].forEach((ref) => {
      ref.current.forEach((card) => {
        if (card.isNew) delete card.isNew;
      });
    });
  });

  // ── 渲染辅助（对齐 createCardElement / renderHand / renderBuildPile）──────
  const renderCard = (card: Card, extraClass = '') => {
    const color = card.suit === '♥' || card.suit === '♦' ? 'red' : 'black';
    return (
      <div className={`speed-card speed-card--${color}${extraClass}`}>
        <div className="speed-card__value">{card.value}</div>
        <div className="speed-card__suit">{card.suit}</div>
      </div>
    );
  };

  const renderHand = (hand: Card[], player: 1 | 2) => {
    const selected = player === 1 ? p1SelectedRef.current : p2SelectedRef.current;
    return hand.map((card, index) => {
      let extra = '';
      if (selected && selected.index === index) extra += ' speed-card--selected';
      if (card.isNew) extra += player === 1 ? ' speed-card--draw-anim-p1' : ' speed-card--draw-anim-p2';
      return (
        <div key={card.id} style={{ display: 'contents' }}>
          {renderCard(card, extra)}
        </div>
      );
    });
  };

  const renderBuildPile = (buildPile: Card[], playing: boolean) => {
    const topCard = buildPile[buildPile.length - 1];
    const empty = !topCard;
    return (
      <div
        className={`speed-pile${empty ? ' speed-pile--empty' : ''}${playing ? ' speed-pile--playing' : ''}`}
      >
        {topCard ? renderCard(topCard) : null}
      </div>
    );
  };

  const winnerVisible = winnerRef.current !== '';
  const promptVisible = isSpeedAllowedRef.current && gameInProgressRef.current;

  return (
    <div className="speed-page">
      <style>{SPEED_CSS}</style>

      <Link href="/game" className="speed-back">
        ← 返回玩具
      </Link>

      <div className="speed-wrapper">
        <div className="speed-game-container">
          {/* 玩家2（上方，黑） */}
          <div className="speed-area">
            <div style={{ color: '#fff' }}>玩家2 (黑)</div>
            <div className="speed-pile">
              <div className="speed-pile__count">{p2DrawRef.current.length}</div>
            </div>
            <div className="speed-hand">{renderHand(p2HandRef.current, 2)}</div>
          </div>

          {/* 中央堆 */}
          <div className="speed-area">
            {renderBuildPile(build1Ref.current, playing1)}
            {renderBuildPile(build2Ref.current, playing2)}
          </div>

          {/* 玩家1（下方，红） */}
          <div className="speed-area">
            <div style={{ color: '#fff' }}>玩家1 (红)</div>
            <div className="speed-pile">
              <div className="speed-pile__count">{p1DrawRef.current.length}</div>
            </div>
            <div className="speed-hand">{renderHand(p1HandRef.current, 1)}</div>
          </div>

          <div className="speed-winner" style={{ display: winnerVisible ? 'block' : 'none' }}>
            {winnerRef.current}
          </div>
          <div className="speed-prompt" style={{ display: promptVisible ? 'block' : 'none' }}>
            僵局！按 [空格键] 翻牌
          </div>
        </div>

        <div className="speed-controls">
          <h3>操作指南</h3>
          <div>
            <b>玩家1 (下方)</b>
            选牌: [Q], [W], [E], [R]
            <br />
            补牌: [A]
            <br />
            出至左堆: [S]
            <br />
            出至右堆: [D]
          </div>
          <div>
            <b>玩家2 (上方)</b>
            选牌: [U], [I], [O], [P]
            <br />
            补牌: [J]
            <br />
            出至左堆: [K]
            <br />
            出至右堆: [L]
          </div>
          <div>
            <b>公共操作</b>
            <br />
            翻牌 (仅限提示时): [空格键]
          </div>
          <button type="button" className="speed-btn" onClick={startGame}>
            重新开始
          </button>
        </div>
      </div>
    </div>
  );
}

// 自包含样式（作用域前缀 speed-*；从 pages/game/_speed.scss 逐一移植。
// 设计令牌映射到 web-next 变量并带回退；卡牌恒为白底以保真）。
const SPEED_CSS = `
.speed-page {
  --speed-card-width: clamp(75px, 6vw, 110px);
  --speed-card-height: calc(var(--speed-card-width) * 1.4);
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: calc(100vh - 62px);
  background: var(--surface-2, #f5f5f7);
  font-size: clamp(12px, 1.2vw, 16px);
  overflow: hidden;
  user-select: none;
  padding: 16px;
}
.speed-back {
  position: absolute;
  top: 16px;
  left: 20px;
  z-index: 10;
  display: inline-block;
  color: var(--ink-2, #6e6e73);
  text-decoration: none;
  font-size: 0.9rem;
  transition: color 0.2s;
}
.speed-back:hover { color: var(--accent, #0071e3); }
.speed-wrapper {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 2rem;
  width: 100%;
  max-width: 1600px;
  justify-content: center;
}
.speed-game-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2rem;
  flex-grow: 1;
  position: relative;
}
.speed-area {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 1rem;
  padding: 1rem;
  gap: 1.5rem;
  min-height: calc(var(--speed-card-height) + 2rem);
  width: 100%;
  box-sizing: border-box;
}
.speed-hand { display: flex; gap: 1rem; perspective: 1000px; }
.speed-card {
  width: var(--speed-card-width);
  height: var(--speed-card-height);
  border-radius: 0.8rem;
  font-size: 2rem;
  font-weight: bold;
  position: relative;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  background-color: #fff;
  border: 2px solid #333;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
}
.speed-card--red { color: #d32f2f; }
.speed-card--black { color: #212121; }
.speed-card--selected {
  transform: translateY(-2rem) scale(1.05);
  box-shadow: 0 0 20px #ffeb3b, 0 0 30px #ffc107;
}
.speed-card--draw-anim-p1 { animation: speed-draw-from-bottom 0.5s ease-out; }
.speed-card--draw-anim-p2 { animation: speed-draw-from-top 0.5s ease-out; }
.speed-card__value { position: absolute; font-size: 1.5rem; top: 0.5rem; left: 0.8rem; }
.speed-card__suit { font-size: 3rem; }
.speed-pile {
  width: var(--speed-card-width);
  height: var(--speed-card-height);
  border-radius: 0.8rem;
  font-size: 2rem;
  font-weight: bold;
  position: relative;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  border: 2px dashed #ccc;
  background-color: #2e7d32;
  display: flex;
  justify-content: center;
  align-items: center;
}
.speed-pile--empty { background-color: rgba(0, 0, 0, 0.1); }
.speed-pile--playing .speed-card { animation: speed-card-play 0.3s ease; }
.speed-pile__count {
  position: absolute;
  bottom: 0.5rem;
  font-size: 1.2rem;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 0.2rem 0.5rem;
  border-radius: 0.5rem;
  color: #fff;
}
.speed-controls {
  background-color: rgba(0, 0, 0, 0.3);
  padding: 2rem;
  border-radius: 1rem;
  text-align: left;
  line-height: 2;
  font-size: 1.2rem;
  width: 300px;
  flex-shrink: 0;
  color: #fff;
}
.speed-controls h3 { margin-top: 0; }
.speed-controls b { display: block; margin-top: 0.5rem; }
.speed-btn {
  padding: 1rem 2rem;
  font-size: 1.2rem;
  cursor: pointer;
  border-radius: 0.5rem;
  border: none;
  background-color: #ffc107;
  color: #000;
  margin-top: 1rem;
  width: 100%;
  transition: background-color 0.2s ease;
}
.speed-btn:hover { background-color: #ffb300; }
.speed-winner {
  font-size: 4rem;
  color: #ffeb3b;
  text-shadow: 2px 2px 4px #000;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background-color: rgba(0, 0, 0, 0.7);
  padding: 2rem 4rem;
  border-radius: 1.5rem;
  z-index: 100;
  text-align: center;
}
.speed-prompt {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background-color: rgba(255, 235, 59, 0.9);
  color: #000;
  padding: 1rem 2rem;
  border-radius: 1rem;
  font-size: 1.5rem;
  font-weight: bold;
  z-index: 50;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
}
@keyframes speed-draw-from-bottom {
  from { transform: translateY(10rem) scale(0.8); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes speed-draw-from-top {
  from { transform: translateY(-10rem) scale(0.8); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes speed-card-play {
  from { transform: scale(0.7); opacity: 0.5; }
  to { transform: scale(1); opacity: 1; }
}
[data-theme="dark"] .speed-area { background-color: rgba(255, 255, 255, 0.05); }
[data-theme="dark"] .speed-card { background-color: #fff; border-color: #555; }
[data-theme="dark"] .speed-controls { background-color: rgba(255, 255, 255, 0.05); }
@media (max-width: 900px) {
  .speed-wrapper { flex-direction: column; gap: 1rem; padding: 0.5rem; }
  .speed-controls { width: 100%; max-width: 400px; padding: 1rem; font-size: 1rem; }
  .speed-winner { font-size: 2.5rem; padding: 1.5rem 2rem; }
}
`;
