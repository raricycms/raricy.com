// 玩具清单只描述陈列方式（标题 / 简介 / 分类 / 模式 / 图标 / 归属合集）；引擎按页面加载，
// 不从这里导入客户端组件。
// href 是清单里唯一与路由重复的字段：本站游戏指向 `src/app/game/<id>/page.tsx`，改路由
// 记得回来同步（漏了不报类型错，症状是卡片点进去 404）。站外游戏把 `external` 设为 true，
// href 写完整 URL，卡片按外链渲染（新窗口打开），不参与站内路由。
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
  { id: 'craft', title: '手工间', parentId: 'test', icon: 'craft' },
] as const satisfies readonly GameCollection[];

export type GameCollectionId = (typeof GAME_COLLECTIONS)[number]['id'];

export interface GameEntry {
  id: string;
  title: string;
  description: string;
  category: keyof typeof GAME_CATEGORIES;
  modes: readonly (keyof typeof GAME_MODES)[];
  /** 本站路由路径；`external: true` 时是站外完整 URL。 */
  href: string;
  /** 站外游戏：卡片渲染成普通 `<a>`，新窗口打开。 */
  external?: boolean;
  collectionId: GameCollectionId | null;
  icon: 'atamas' | 'wand' | 'public-space' | 'quandi' | 'twinshade' | 'lumen' | 'yiwen' | 'hinge' | 'loom' | 'papercut' | 'marbling' | 'motion' | 'rarica' | 'rariroom' | 'ling' | 'reality' | 'fish-trade' | 'fish-trade-sim';
  /**
   * 可见门槛（缺省 = 含匿名在内所有人都看得到）。取值是**被链接页面自己的可用性口径**：
   * `'fish-trade'` = 只有能进 `/fish/trade` 的人才看得到（core+ 且未被「屏蔽鱼干练手盘」）。
   * 清单是编译期数据、不知道看的人是谁，所以这里只写门槛，由页面用 `gameVisibleTo()`
   * 按会话过滤。这是站长明确要求的「入口跟着档位藏」例外（站规默认是入口不藏、点了 403）。
   */
  gate?: 'fish-trade';
}

export const GAMES = [
  {
    id: 'loom',
    title: '小小织布机',
    description: '拖着梭子在经线间走一个来回就是一行，压紧、换梭口都会自己发生。可逐行换色、反悔与导出。',
    category: 'craft',
    modes: ['solo'],
    href: '/game/loom',
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
    collectionId: 'test',
    icon: 'motion',
  },
  {
    id: 'rarica',
    title: '莱莉卡',
    description: '抽卡、组卡，和山人对战。45 张卡、四种花色、三种玩法，一局五分钟。',
    category: 'social',
    modes: ['solo', 'online'],
    href: 'https://rarica.raricy.com',
    external: true,
    collectionId: null,
    icon: 'rarica',
  },
  {
    id: 'rariroom',
    title: '放映厅',
    description: '一起看同一块屏幕：屏幕共享与影院模式，多人同步播放。',
    category: 'social',
    modes: ['online'],
    href: 'https://rariroom.raricy.com',
    external: true,
    collectionId: null,
    icon: 'rariroom',
  },
  {
    id: 'ling',
    title: '灵性实验室',
    description: '跟着 Neko 做四个小实验：隐藏信息感知、未来事件预知、双人感应与日常体验记录。',
    category: 'social',
    modes: ['solo', 'local'],
    href: 'https://ling.raricy.com',
    external: true,
    collectionId: null,
    icon: 'ling',
  },
  {
    id: 'reality',
    title: '灵感菇树林',
    description: '午后的秋日林子：灵摆与硬币占卜、纸人替身，还能给板块调频。',
    category: 'social',
    modes: ['solo'],
    href: 'https://reality.raricy.com',
    external: true,
    collectionId: null,
    icon: 'reality',
  },
  {
    id: 'fish-trade',
    title: '鱼干练手盘',
    description: '用站内小鱼干做多或做空真实行情，开仓、平仓与结算都在站内完成。',
    category: 'puzzle',
    modes: ['solo'],
    href: '/fish/trade',
    collectionId: null,
    icon: 'fish-trade',
    gate: 'fish-trade',
  },
  {
    id: 'fish-trade-sim',
    title: '鱼干练手盘（模拟版）',
    description: '站外模拟交易台：1 万小鱼干起步，1–100 倍杠杆，行情每秒刷新。',
    category: 'puzzle',
    modes: ['solo'],
    href: 'https://fish.raricy.com',
    external: true,
    collectionId: null,
    icon: 'fish-trade-sim',
  },
] as const satisfies readonly GameEntry[];

/** 可见性判定所需的最小字段：由页面从会话算好，本模块不 import auth / prisma。 */
export interface GameViewer {
  /** 当前查看者是否 core+（匿名一律 false）。 */
  core: boolean;
  /** 当前查看者的「屏蔽鱼干练手盘」是否生效。 */
  fishTradeBlocked: boolean;
}

/**
 * 清单里的门卡片对当前查看者是否可见（见 `GameEntry.gate`）。
 *
 * 单独一个纯函数是为了让两个陈列页与将来其它入口用**同一套**判据：把 `gate` 直接写进
 * JSX 的条件里，第二个页面就会漏掉其中一半（core 或专注屏蔽），而且不报错。
 */
export function gameVisibleTo(
  game: Pick<GameEntry, 'gate'>,
  viewer: GameViewer,
): boolean {
  if (game.gate === 'fish-trade') return viewer.core && !viewer.fishTradeBlocked;
  return true;
}

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

