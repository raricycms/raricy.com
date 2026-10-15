// 游戏清单只描述陈列与启动方式；引擎按页面加载，不从这里导入客户端组件。
export const GAME_CATEGORIES = { puzzle: '益智' } as const;
export const GAME_MODES = { solo: '单人' } as const;

interface GameEntry {
  id: string;
  title: string;
  description: string;
  category: keyof typeof GAME_CATEGORIES;
  modes: readonly (keyof typeof GAME_MODES)[];
  href: string;
  runtime: 'native' | 'embedded' | 'external';
}

export const GAMES = [
  {
    id: 'atamas',
    title: 'ATÅMAS',
    description: '在圆环上放置数字与加号，触发连锁合并，挑战更高分。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/atamas',
    runtime: 'native',
  },
] as const satisfies readonly GameEntry[];
