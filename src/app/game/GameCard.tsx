import Link from 'next/link';
import { Grid2X2, Wand2, Flag } from 'lucide-react';
import { AtamasRingIcon } from '@/games/atamas/icons';
import { TwinShadeIcon } from '@/games/twinshade/icons';
import { LumenIcon } from '@/games/lumen/icons';
import { GAME_CATEGORIES, GAME_MODES, type GameEntry } from '@/lib/game-catalog';

/** 图标按 game-catalog 的 `icon` 字段选；新增游戏时在这里加一支，别把标签塞进清单。 */
function GameIcon({ icon }: { icon: GameEntry['icon'] }) {
  if (icon === 'lumen') return <LumenIcon />;
  if (icon === 'atamas') return <AtamasRingIcon />;
  if (icon === 'twinshade') return <TwinShadeIcon />;
  if (icon === 'public-space') return <Grid2X2 />;
  if (icon === 'quandi') return <Flag />;
  return <Wand2 />;
}

export default function GameCard({ game }: { game: GameEntry }) {
  return (
    <Link href={game.href} className="game-card">
      <span className="game-card__icon" aria-hidden="true"><GameIcon icon={game.icon} /></span>
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
