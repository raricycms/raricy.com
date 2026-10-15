// 游戏清单只描述陈列与启动方式；引擎按页面加载，不从这里导入客户端组件。
export const GAME_CATEGORIES = { puzzle: '益智', action: '动作' } as const;
export const GAME_MODES = { solo: '单人', online: '在线多人' } as const;

export const GAME_COLLECTIONS = [{ id: 'test', title: '测试', href: '/game/collections/test' }] as const;

export interface GameEntry {
  id: string;
  title: string;
  description: string;
  category: keyof typeof GAME_CATEGORIES;
  modes: readonly (keyof typeof GAME_MODES)[];
  href: string;
  runtime: 'native' | 'embedded' | 'external';
  collectionId: typeof GAME_COLLECTIONS[number]['id'] | null;
  icon: 'atamas' | 'wand';
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
    collectionId: null,
    icon: 'atamas',
  },
  {
    id: 'wand',
    title: 'Wand demo',
    description: '在草地上移动，避开湖泊，与其他玩家同步位置。',
    category: 'action',
    modes: ['online'],
    href: '/game/wand',
    runtime: 'native',
    collectionId: 'test',
    icon: 'wand',
  },
] as const satisfies readonly GameEntry[];
