import Link from 'next/link';
import { Activity, ExternalLink, Flag, Grid2X2, Swords, Wand2 } from 'lucide-react';
import { AtamasRingIcon } from '@/games/atamas/icons';
import { TwinShadeIcon } from '@/games/twinshade/icons';
import { LumenIcon } from '@/games/lumen/icons';
import { YiwenIcon } from '@/games/yiwen/art';
import { HingeIcon } from '@/games/hinge/art';
import { LoomIcon, MarblingIcon, PaperCutIcon } from '@/games/craft/icons';
import { GAME_CATEGORIES, GAME_MODES, type GameEntry } from '@/lib/game-catalog';

/** 图标按 game-catalog 的 `icon` 字段选；新增游戏时在这里加一支，别把标签塞进清单。 */
function GameIcon({ icon }: { icon: GameEntry['icon'] }) {
  if (icon === 'loom') return <LoomIcon />;
  if (icon === 'papercut') return <PaperCutIcon />;
  if (icon === 'marbling') return <MarblingIcon />;
  if (icon === 'hinge') return <HingeIcon />;
  if (icon === 'yiwen') return <YiwenIcon />;
  if (icon === 'lumen') return <LumenIcon />;
  if (icon === 'atamas') return <AtamasRingIcon />;
  if (icon === 'twinshade') return <TwinShadeIcon />;
  if (icon === 'public-space') return <Grid2X2 />;
  if (icon === 'quandi') return <Flag />;
  if (icon === 'motion') return <Activity />;
  if (icon === 'rarica') return <Swords />;
  return <Wand2 />;
}

/** 卡片内容：站内与站外共用，只有外层链接不同。 */
function GameCardContent({ game }: { game: GameEntry }) {
  return (
    <>
      <span className="game-card__icon" aria-hidden="true"><GameIcon icon={game.icon} /></span>
      <h2>{game.title}</h2>
      <div className="game-card__tags">
        <span>{GAME_CATEGORIES[game.category]}</span>
        {game.modes.map((mode) => <span key={mode}>{GAME_MODES[mode]}</span>)}
      </div>
      <p>{game.description}</p>
      <span className="game-action">
        开始游戏
        {game.external && <ExternalLink size={16} aria-hidden="true" />}
      </span>
    </>
  );
}

export default function GameCard({ game }: { game: GameEntry }) {
  if (game.external) {
    return (
      <a href={game.href} className="game-card" target="_blank" rel="noopener noreferrer">
        <GameCardContent game={game} />
      </a>
    );
  }
  return (
    <Link href={game.href} className="game-card">
      <GameCardContent game={game} />
    </Link>
  );
}
