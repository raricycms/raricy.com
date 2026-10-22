// 游戏清单只描述陈列与启动方式；引擎按页面加载，不从这里导入客户端组件。
export const GAME_CATEGORIES = { puzzle: '益智', action: '动作', social: '互动' } as const;
export const GAME_MODES = { solo: '单人', local: '本地双人', online: '在线多人' } as const;

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
  icon: 'atamas' | 'wand' | 'public-space' | 'quandi' | 'twinshade' | 'lumen' | 'yiwen';
}

export const GAMES = [
  {
    id: 'yiwen',
    title: '异文 Demo',
    description: '观察图形，组合符号，自己发现一套未知语言的规则。七张可自由试验的卡片，以及一块等待解读的铭牌。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/yiwen',
    runtime: 'native',
    collectionId: 'test',
    icon: 'yiwen',
  },
  {
    id: 'lumen',
    title: '折光',
    description: '转动镜片，让光线分流、交汇、穿过传送门。22 个循序渐进的光路谜题，支持提示、撤销与进度保存。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/lumen',
    runtime: 'native',
    collectionId: null,
    icon: 'lumen',
  },
  {
    id: 'twinshade',
    title: '双影',
    description: '一次操作，两个身体：让本体与影子各自踩上一盏灯。三章关卡，逐步引入推石、同纹石块与冰面滑行。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/twinshade',
    runtime: 'native',
    collectionId: null,
    icon: 'twinshade',
  },
  {
    id: 'wand2',
    title: 'Wand demo 2',
    description: '化身猫耳剑士，在共享草地上迎战史莱姆，收集猫薄荷并争夺实时排行。',
    category: 'action',
    modes: ['online'],
    href: '/game/wand2',
    runtime: 'native',
    collectionId: 'test',
    icon: 'wand',
  },
  {
    id: 'quandi',
    title: '圈地运动',
    description: '移动留下轨迹，闭合圈地，与朋友争夺领土。支持本地双人和账号联机，推荐电脑游玩。',
    category: 'action',
    modes: ['local', 'online'],
    href: '/game/quandi',
    runtime: 'embedded',
    collectionId: 'test',
    icon: 'quandi',
  },
  {
    id: 'public-space',
    title: '公共空间',
    description: '在 5 × 5 网格中放置自己的头像，与在线用户共享空间，空闲时可留在观众席。',
    category: 'social',
    modes: ['online'],
    href: '/game/public-space',
    runtime: 'native',
    collectionId: 'test',
    icon: 'public-space',
  },
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
