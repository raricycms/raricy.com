import Link from 'next/link';
import type { Metadata } from 'next';
import { GAMES, GAME_CATEGORIES, GAME_MODES } from '@/lib/game-catalog';
import { AtamasRingIcon } from '@/games/atamas/icons';

export const metadata: Metadata = { title: '玩具 · 聪明山' };

export default function GameMenuPage() {
  return (
    <div className="container game-menu">
      <h1>玩具</h1>
      <div className="game-grid">
        {GAMES.map((game) => (
          <Link key={game.id} href={game.href} className="game-card">
            <AtamasRingIcon />
            <h2>{game.title}</h2>
            <div className="game-card__tags">
              <span>{GAME_CATEGORIES[game.category]}</span>
              {game.modes.map((mode) => <span key={mode}>{GAME_MODES[mode]}</span>)}
            </div>
            <p>{game.description}</p>
            <span className="game-action">开始游戏</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
