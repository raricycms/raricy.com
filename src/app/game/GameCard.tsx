import Link from 'next/link';
import { Grid2X2, Wand2, Flag } from 'lucide-react';
import { AtamasRingIcon } from '@/games/atamas/icons';
import { GAME_CATEGORIES, GAME_MODES, type GameEntry } from '@/lib/game-catalog';

export default function GameCard({ game }: { game: GameEntry }) {
  return (
    <Link href={game.href} className="game-card">
      <span className="game-card__icon" aria-hidden="true">{game.icon === 'atamas' ? <AtamasRingIcon /> : game.icon === 'public-space' ? <Grid2X2 /> : game.icon === 'quandi' ? <Flag /> : <Wand2 />}</span>
      <h2>{game.title}</h2>
      <div className="game-card__tags">
        <span>{GAME_CATEGORIES[game.category]}</span>
        {game.modes.map((mode) => <span key={mode}>{GAME_MODES[mode]}</span>)}
      </div>
      <p>{game.description}</p>
      <span className="game-action">开始游戏</span>
    </Link>
  );
}
