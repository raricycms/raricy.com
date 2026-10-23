// 游戏清单只描述陈列与启动方式；引擎按页面加载，不从这里导入客户端组件。
export const GAME_CATEGORIES = { puzzle: '益智', action: '动作', social: '互动', craft: '手工' } as const;
export const GAME_MODES = { solo: '单人', local: '本地双人', online: '在线多人' } as const;

export const GAME_COLLECTIONS = [
  { id: 'craft', title: '手工间', href: '/game/collections/craft', icon: 'craft' },
  { id: 'test', title: '测试', href: '/game/collections/test', icon: 'flask' },
] as const;

export interface GameEntry {
  id: string;
  title: string;
  description: string;
  category: keyof typeof GAME_CATEGORIES;
  modes: readonly (keyof typeof GAME_MODES)[];
  href: string;
  runtime: 'native' | 'embedded' | 'external';
  collectionId: typeof GAME_COLLECTIONS[number]['id'] | null;
  icon: 'atamas' | 'wand' | 'public-space' | 'quandi' | 'twinshade' | 'lumen' | 'yiwen' | 'hinge' | 'loom' | 'papercut' | 'marbling';
}

export const GAMES = [
  {
    id: 'loom',
    title: '小小织布机',
    description: '选择经线配色，拖动梭子一行行织出小布块。可逐行换色、撤销与导出。',
    category: 'craft',
    modes: ['solo'],
    href: '/game/loom',
    runtime: 'native',
    collectionId: 'craft',
    icon: 'loom',
  },
  {
    id: 'papercut',
    title: '剪纸窗花',
    description: '在折好的纸上随手剪几刀，展开成对称窗花。支持两折、三折与透明底导出。',
    category: 'craft',
    modes: ['solo'],
    href: '/game/papercut',
    runtime: 'native',
    collectionId: 'craft',
    icon: 'papercut',
  },
  {
    id: 'marbling',
    title: '水面印花',
    description: '滴入颜料，用针或梳子拖出纹理，再用纸吸起花纹。支持撤销与图片导出。',
    category: 'craft',
    modes: ['solo'],
    href: '/game/marbling',
    runtime: 'native',
    collectionId: 'craft',
    icon: 'marbling',
  },
  {
    id: 'hinge',
    title: '合页 Demo',
    description: '滑动、转动承载房间的纸片，改变门之间的连接。五个练习与一张从开局就能尝试的主谜题。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/hinge',
    runtime: 'native',
    collectionId: 'test',
    icon: 'hinge',
  },
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
    collectionId: 'test',
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
    collectionId: 'test',
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
