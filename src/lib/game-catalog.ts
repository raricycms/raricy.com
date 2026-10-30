// 玩具清单只描述陈列与启动方式；引擎按页面加载，不从这里导入客户端组件。
//
// 【合集可以嵌套】合集只登记 `parentId`，**URL 由父链推出来**，不在清单里存 href。
// 存一份 href 的话，改父链就得记得回来同步那个字符串 —— 漏了不会报类型错，
// 症状是「卡片点进去 404」。层级深度不限：玩具首页只陈列顶层合集，合集页陈列
// 「直属游戏 + 子合集」，路径就是 `/game/collections/<父>/<子>`。
export const GAME_CATEGORIES = { puzzle: '益智', action: '动作', social: '互动', craft: '手工' } as const;
export const GAME_MODES = { solo: '单人', local: '本地双人', online: '在线多人' } as const;

/** 合集图标键；具体画哪一支由 `GameCollectionCard` 决定，别把 JSX 塞进清单。 */
export type GameCollectionIcon = 'craft' | 'flask';

export interface GameCollection {
  id: string;
  title: string;
  /** 父合集 id；`null` 表示顶层合集。 */
  parentId: string | null;
  icon: GameCollectionIcon;
}

export const GAME_COLLECTIONS = [
  { id: 'test', title: '实验室', parentId: null, icon: 'flask' },
  { id: 'craft', title: '手工间', parentId: null, icon: 'craft' },
] as const satisfies readonly GameCollection[];

export type GameCollectionId = (typeof GAME_COLLECTIONS)[number]['id'];

export interface GameEntry {
  id: string;
  title: string;
  description: string;
  category: keyof typeof GAME_CATEGORIES;
  modes: readonly (keyof typeof GAME_MODES)[];
  href: string;
  runtime: 'native' | 'embedded' | 'external';
  collectionId: GameCollectionId | null;
  icon: 'atamas' | 'wand' | 'public-space' | 'quandi' | 'twinshade' | 'lumen' | 'yiwen' | 'hinge' | 'loom' | 'papercut' | 'marbling' | 'motion';
}

export const GAMES = [
  {
    id: 'loom',
    title: '小小织布机',
    description: '拖着梭子在经线间走一个来回就是一行，压紧、换梭口都会自己发生。可逐行换色、反悔与导出。',
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
    description: '在折好的纸上剪几刀，把纸拉开就是一朵镜像对称的窗花。两折、三折，透明底导出。',
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
    description: '滴颜料、拖出纹理，再把纸放进水里吸起花纹。可撤销与导出。',
    category: 'craft',
    modes: ['solo'],
    href: '/game/marbling',
    runtime: 'native',
    collectionId: 'craft',
    icon: 'marbling',
  },
  {
    id: 'hinge3',
    title: '合页 Demo 3',
    description: '折起双面纸，让湿墨留下真正的镜像印痕。五道关于转印方向、镂空与正反面的纸面谜题。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/hinge3',
    runtime: 'native',
    collectionId: 'test',
    icon: 'hinge',
  },
  {
    id: 'hinge2',
    title: '合页 Demo 2',
    description: '转动整张纸页，走进镜中道路，沿折痕对折空间。四张立体纸景，从单个机关到组合谜题。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/hinge2',
    runtime: 'native',
    collectionId: 'test',
    icon: 'hinge',
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
    id: 'lumen2',
    title: '折光 2',
    description: '有限的镜片，两束相互牵制的光。12 道关于放置、留空与共用的光路谜题，不计步数，只看解法。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/lumen2',
    runtime: 'native',
    collectionId: 'test',
    icon: 'lumen',
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
  {
    id: 'motion',
    title: '动效试验台',
    description: '同一段动画按不同速度曲线与时长并排播放，用来挑全站动效要用的曲线。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/game/motion',
    runtime: 'native',
    collectionId: 'test',
    icon: 'motion',
  },
] as const satisfies readonly GameEntry[];

/** 按 id 找合集；找不到回 undefined（调用方自己决定 404 还是抛错）。 */
export function gameCollection(id: string): GameCollection | undefined {
  return GAME_COLLECTIONS.find((entry) => entry.id === id);
}

/**
 * 从根到该合集的完整父链（含自身）。`parentId` 指向不存在的合集或成环时抛错 ——
 * 清单是编译期数据，宁可构建 / 首次请求时就炸，也别让「合集静默消失」活下来。
 */
export function collectionPath(id: string): GameCollection[] {
  const seen = new Set<string>();
  const path: GameCollection[] = [];
  let current = gameCollection(id);
  if (!current) throw new Error(`未知的玩具合集：${id}`);
  for (;;) {
    if (seen.has(current.id)) {
      throw new Error(`玩具合集的 parentId 成环：${[...seen, current.id].join(' → ')}`);
    }
    seen.add(current.id);
    path.unshift(current);
    if (current.parentId === null) return path;
    const parent = gameCollection(current.parentId);
    if (!parent) {
      throw new Error(`玩具合集 ${current.id} 的 parentId 指向不存在的合集：${current.parentId}`);
    }
    current = parent;
  }
}

/** 合集的规范 URL（由父链推出）；顶层是 `/game/collections/<id>`，每深一层多一段。 */
export function collectionHref(id: string): string {
  return `/game/collections/${collectionPath(id).map((entry) => entry.id).join('/')}`;
}

/** 顶层合集 —— 玩具首页陈列的就是这一批。 */
export function topLevelCollections(): GameCollection[] {
  return GAME_COLLECTIONS.filter((entry) => entry.parentId === null);
}

/** 直接子合集（只查一层；孙合集由子合集自己的页面陈列）。 */
export function childCollections(parentId: string): GameCollection[] {
  return GAME_COLLECTIONS.filter((entry) => entry.parentId === parentId);
}

/**
 * 按 URL 段逐级解析成一个「id 链」并返回末端合集。
 *
 * ⚠️ 它**不要求**首段是顶层：`['craft']` 会解析出手工间，调用方随后拿
 * `collectionPath()` 比对规范路径 —— 不一致就永久跳转（旧的顶层地址就是这么救的）。
 * 整段对不上（父链断了 / 不存在 / 空路径）回 null，交给页面 404。
 */
export function collectionByPath(slugs: readonly string[]): GameCollection | null {
  // 已发布的旧父链保留跳转，不能把其他断链路径泛化为有效路径。
  if (slugs.length === 2 && slugs[0] === 'test' && slugs[1] === 'craft') return gameCollection('craft') ?? null;
  const [head, ...rest] = slugs;
  let current = head ? gameCollection(head) : undefined;
  if (!current) return null;
  for (const slug of rest) {
    const next = gameCollection(slug);
    if (!next || next.parentId !== current.id) return null;
    current = next;
  }
  return current;
}
