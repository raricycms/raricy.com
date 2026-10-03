// ─────────────────────────────────────────────────────────────────────────────
// docs-catalog.ts —— 站内文档页（/docs）的**登记表**与 URL 口径
//
// 【它是什么】`docs/` 下的每一份 Markdown 都是一份对外可读的文档，本文件是「谁在
// 站上、按什么顺序、叫什么标题」的唯一清单，`/docs` 的索引页与正文页都读它。
//
// 【为什么要有登记表，而不是扫盘生成】扫盘能省掉这份表，但会让**顺序、标题、分组**
// 三件事退化成「按文件名排」—— 索引页是给人看的目录，顺序是编辑决定。更要紧的是
// 反过来的那一半：扫描方案下**漏掉一份文档不会有任何症状**（它只是不出现），而
// 登记表方案下 `tests/unit/docs-catalog.test.ts` 会当场报「磁盘上有、表里没有」。
// 与本仓其它静态台账（`FRAME_KEYS`、头像落点表）同一条纪律：**静默少一个**是最难
// 发现的一类故障，宁可让人加文档时多写一行。
//
// 【路径即 slug】条目的 `slug` 就是文件相对 `docs/` 的路径去掉 `.md`，URL 也原样用它
//（`docs/bot/chat-bot.md` → `/docs/bot/chat-bot`）。**刻意不做第二套命名**：另起一套
// 英文 slug 等于多一张会漂的对照表，而本仓文档改名时守卫只能拦住一半。
//
// 【标题必须与文档 H1 一致】索引页显示 `title`，正文页显示文档自己的 H1 —— 两者
// 不一致时读者会在目录里看到 A、点进去看到 B。守卫按「去掉反引号与多余空白后相等」
// 比对，所以 H1 里的行内代码（`内容引用语法 \`[@ ]\` 使用指南`）不会逼着索引也带反引号。
//
// 【与那 6 个指南页的关系】`/image/guide` 这类既有页面仍然按文件名读盘渲染
//（`MarkdownGuide.tsx`），本表的条目与它们**并存**：同一份文档因此有两个站内 URL。
// 这是刻意留的 —— 那些页面被工具页与线上冒烟钉着（见 `docs/README.md`），
// 合并是一次独立的改动，不在这份表里顺手做。
//
// 本文件**零 import**：它被服务端页面与 node 侧的守卫测试共用，别把 fs / marked
// 或者任何 Next 专有的东西拖进来。
// ─────────────────────────────────────────────────────────────────────────────

/** 站内文档的分组。`key` 只在这里出现一次，条目的 `group` 引用它。 */
export const DOC_GROUPS = [
  {
    key: 'guide',
    title: '给玩家与创作者',
    description: '站内功能的用法：图床、音频床、剪贴板、投票、收藏夹、头像框、表情包、故事脚本。',
  },
  {
    key: 'bot',
    title: '给机器人开发者',
    description: '站外机器人接入的接口契约。十三份都自包含 —— 不读本站源码也能对接。',
  },
  {
    key: 'dev',
    title: '开发与运维',
    description: '本站自己的设计与运维：架构、部署、CLI、OAuth、样式规范、灾备与历史遗留清单。',
  },
] as const;

export type DocGroupKey = (typeof DOC_GROUPS)[number]['key'];

export interface DocEntry {
  /** 相对 `docs/` 的路径去掉 `.md`。同时是 URL 路径（路径即 slug）。 */
  slug: string;
  /** 索引页显示的名字。**必须与文档 H1 一致**（守卫比对，见文件头）。 */
  title: string;
  /** 索引页名字下面那一行。一句话，别换行。 */
  summary: string;
  group: DocGroupKey;
}

/**
 * 登记表 —— `docs/` 下每一份 `.md` 都要在这里，**一份一条**。
 * 数组顺序即索引页顺序（组内自上而下）。
 */
export const DOC_ENTRIES: readonly DocEntry[] = [
  // ── 给玩家与创作者 ────────────────────────────────────────────────────────
  {
    group: 'guide',
    slug: 'guide/内容引用语法指南',
    title: '内容引用语法 [@ ] 使用指南',
    summary: '在博客、评论、讨论里嵌入图床图、音频、剪贴板、投票、收藏夹与用户名片。',
  },
  {
    group: 'guide',
    slug: 'guide/表情包使用指南',
    title: '表情包使用指南',
    summary: '[@合集/表情] 怎么用、内置黄脸栏与站长自加素材。',
  },
  {
    group: 'guide',
    slug: 'guide/云剪贴板使用指南',
    title: '云剪贴板使用指南',
    summary: 'Markdown 内容的创建、管理与复用。',
  },
  {
    group: 'guide',
    slug: 'guide/图床使用指南',
    title: '图床使用指南',
    summary: '图片托管：上传、直链、压缩与配额。',
  },
  {
    group: 'guide',
    slug: 'guide/音频床使用指南',
    title: '音频床使用指南',
    summary: '音乐与语音留言托管：上传、直链、格式兼容性与 [@音频/ID] 引用。',
  },
  {
    group: 'guide',
    slug: 'guide/投票箱使用指南',
    title: '投票箱使用指南',
    summary: '创建投票、投票，以及把投票嵌进博客。',
  },
  {
    group: 'guide',
    slug: 'guide/收藏夹使用指南',
    title: '收藏夹使用指南',
    summary: '私密与公开的区别、复制、分享、导入导出。',
  },
  {
    group: 'guide',
    slug: 'guide/头像框使用指南',
    title: '头像框使用指南',
    summary: '怎么换头像框、怎么用鱼干租一款、到期之后会怎样。',
  },
  {
    group: 'guide',
    slug: 'guide/头像框出图规范',
    title: '头像框出图规范',
    summary: '给画师的出图规格（自包含，可整份转发）。',
  },
  {
    group: 'guide',
    slug: 'guide/cattca-guide',
    title: 'Cattca 入门指南',
    summary: 'Cattca 互动叙事的零基础入门。',
  },
  {
    group: 'guide',
    slug: 'guide/cattca-syntax',
    title: 'Cattca 脚本语法文档',
    summary: '脚本语法的逐条参考。',
  },
  {
    group: 'guide',
    slug: 'guide/story-module',
    title: '故事模块',
    summary: '故事区的文件结构、合集嵌套与 URL。',
  },

  // ── 给机器人开发者 ────────────────────────────────────────────────────────
  {
    group: 'bot',
    slug: 'bot/chat-bot',
    title: '讨论机器人接入说明',
    summary: '接口契约、SSE、消息与表情、正在输入 / 已读 / 报到、限频。',
  },
  {
    group: 'bot',
    slug: 'bot/comment-bot',
    title: '博客评论区机器人接入说明',
    summary: '接口契约、轮询与限频。',
  },
  {
    group: 'bot',
    slug: 'bot/blog-bot',
    title: '博客发文机器人接入说明',
    summary: '取栏目、发文与改文、对外可见性三档、每日 20 篇。',
  },
  {
    group: 'bot',
    slug: 'bot/vote-bot',
    title: '投票机器人接入说明',
    summary: '建 / 投 / 读结果，以及锁定与删除。',
  },
  {
    group: 'bot',
    slug: 'bot/checkin-bot',
    title: '签到机器人接入说明',
    summary: '签到两步走；每人每天一次、跨 UTC+8 午夜的作废窗口。',
  },
  {
    group: 'bot',
    slug: 'bot/like-feed-bot',
    title: '点赞与投喂机器人接入说明',
    summary: '文章与评论点赞（切换式）、投喂鱼干、名单、删自己的评论。',
  },
  {
    group: 'bot',
    slug: 'bot/image-bot',
    title: '图床机器人接入说明',
    summary: 'multipart 上传、部分成功的响应形状、配额与直链。',
  },
  {
    group: 'bot',
    slug: 'bot/audio-bot',
    title: '音频床机器人接入说明',
    summary: 'multipart 上传（一次一个）、内容嗅探与格式别名、独立配额、Range 直链。',
  },
  {
    group: 'bot',
    slug: 'bot/clipboard-bot',
    title: '云剪贴板机器人接入说明',
    summary: '建 / 改 / 删与 [@8位ID] 引用。',
  },
  {
    group: 'bot',
    slug: 'bot/account-bot',
    title: '账号与通知接口说明',
    summary: '资料与开关、专注模式、通知（含批量与 SSE）、公开主页、禁言历史、改密与邀请码提权。',
  },
  {
    group: 'bot',
    slug: 'bot/fish-bot',
    title: '鱼干机器人接入说明（无状态接口）',
    summary: '只读凭据与无状态转账、余额、流水；收银台与收款回调。',
  },
  {
    group: 'bot',
    slug: 'bot/fish-bank-example',
    title: '一个最小的鱼干银行（可运行的参考实现）',
    summary: '建号 / 凭据 / 回调 / 收款 / 验签 / 提现 / 对账，整段可复制。',
  },
  {
    group: 'bot',
    slug: 'bot/trade-bot',
    title: '练手盘机器人接入说明',
    summary: '行情 / 开仓 / 平仓；成交价现取、结算公式、下单限频与两个静默陷阱。',
  },
  {
    group: 'bot',
    slug: 'bot/favorite-bot',
    title: '收藏夹接口（读公开收藏夹 · 站内写入）',
    summary: '按 6 位 ID 读公开收藏夹；站内写入的接口与所有者限定。',
  },

  // ── 开发与运维 ────────────────────────────────────────────────────────────
  {
    group: 'dev',
    slug: 'architecture',
    title: '项目架构',
    summary: '进程拓扑、路由、子系统、数据流与风险。',
  },
  {
    group: 'dev',
    slug: 'deploy',
    title: '部署与运行',
    summary: '从零到上线：环境、数据库、systemd、nginx、TLS、备份与排障。',
  },
  {
    group: 'dev',
    slug: 'cli',
    title: '运维 CLI',
    summary: '交互式向导与命令式用法；角色、用户、内容检索与恢复、鱼干、头像框、邀请码、审计、申诉。',
  },
  {
    group: 'dev',
    slug: 'oauth',
    title: 'OAuth 2.0 身份绑定系统',
    summary: '本站作为 OAuth 2.0 IdP 的完整协议与集成方式。',
  },
  {
    group: 'dev',
    slug: 'frontend-styles',
    title: '前端样式规范',
    summary: 'SCSS 目录、设计令牌、组件约定与响应式。',
  },
  {
    group: 'dev',
    slug: 'instance-restore',
    title: '从 instance.zip 还原数据目录与数据库',
    summary: '灾备：从备份包还原出可运行的 instance/。',
  },
  {
    group: 'dev',
    slug: 'legacy-constraints',
    title: '历史遗留约束清单',
    summary: '哪些老东西不能删、为什么不能删。',
  },
  {
    group: 'dev',
    slug: 'README',
    title: '文档索引',
    summary: '本目录的索引与互指规范（给改文档的人）。',
  },
];

/** 站外仓库地址 —— 文档正文里指向源码的链接改写到这儿（见 rewriteDocHref）。 */
export const REPO_URL = 'https://github.com/raricycms/raricy.com';
const REPO_BLOB = `${REPO_URL}/blob/main`;

const BY_SLUG = new Map(DOC_ENTRIES.map((e) => [e.slug, e]));

/** 某一组里的条目，顺序即登记顺序。 */
export function docEntriesOfGroup(group: DocGroupKey): DocEntry[] {
  return DOC_ENTRIES.filter((e) => e.group === group);
}

/** 条目 → 站内 URL。中文路径逐段转义（`/docs/guide/%E5%9B%BE...`）。 */
export function docHref(slug: string): string {
  return '/docs/' + slug.split('/').map(encodeURIComponent).join('/');
}

/** 仓库内文件的 GitHub 地址（`docs/bot/chat-bot.md` → 仓库里那一份）。 */
export function repoFileUrl(repoPath: string): string {
  return `${REPO_BLOB}/${repoPath}`;
}

/**
 * URL 段 → 登记表条目。**返回 null 就是 404**，调用方别自己拼路径。
 *
 * 查表而不是拼路径，是这一层的全部安全性所在：`params` 里可能出现
 * `..`、`%2e%2e%2f`、绝对路径等任何东西，而它们都在 `BY_SLUG` 里查不到 ——
 * 于是「越出 docs/ 读别的文件」这条路在结构上就不存在，不靠过滤字符去挡。
 */
export function findDocEntry(slug: readonly string[]): DocEntry | null {
  const parts: string[] = [];
  for (const raw of slug) {
    const seg = decodeSegment(raw);
    if (seg === null) return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return BY_SLUG.get(parts.join('/')) ?? null;
}

/**
 * 一段 URL 解出它表示的名字。解不出来（或解出来带着路径分隔符）就返回 null。
 *
 * 两种输入都要吃得下：Next 给到的既可能是已解码的 `图床使用指南`，也可能是原样的
 * `%E5%9B%BE...`。多解一次对纯中文/ASCII 是无害的（`decodeURIComponent` 无副作用），
 * 所以不去猜「这一版给的是哪种」，两种都归一化到同一个键。
 *
 * 解出来含 `/` 或 `\` 的一律拒掉：`guide%2F投票箱使用指南` 能解出一个**跨越两段**的
 * 名字，那会凭空造出同一篇文档的第二个 URL。让它 404，不留这种别名。
 */
function decodeSegment(raw: string): string | null {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* 不是合法转义（例如名字里真有 %）—— 按原样处理 */
  }
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\')) return null;
  return s;
}

/**
 * 把**文档正文里的一个链接**改写成站内点得开、或站外找得到的地址。
 *
 * 判据（`fromSlug` 是当前正在渲染的文档）：
 *   · 绝对路径 / 带协议 / `#锚点` → 原样返回（站内路由、外链、脚注都别动）
 *   · 相对链接按**文档在仓库里的位置**解析（`docs/<目录>/`），不是按站点 URL 解析
 *     —— 这是 markdown 的语义，也是 GitHub 上的语义，两边必须一致
 *   · 落点正好是本站登记的文档 → 站内页 `/docs/...`
 *   · 其余（源码、脚本、配置、素材）→ 仓库里的那一份
 *
 * 【为什么必须有这一步】`docs/` 里有两种真链接：`docs/guide/内容引用语法指南.md`
 * 里的 `[表情包使用指南](表情包使用指南.md)`（5 处）与 `docs/frontend-styles.md` 里的
 * `[src/app/layout.tsx](../src/app/layout.tsx)`（4 处）。原样渲染时前者会落到
 * `/docs/guide/表情包使用指南.md`（404，多一个 `.md`）、后者会落到
 * `/docs/src/app/layout.tsx`（404）—— **九个死链，页面上没有任何报错**，
 * 只有点的人知道。GitHub 上它们是好的，所以这层改写也是「站内与仓库读同一份文档」的
 * 前提。新增文档时照旧写相对链接即可，不必迁就站内路由。
 *
 * 越出仓库根（`../../..`）时不做猜测，原样返回 —— 那是文档自己的问题，
 * 不是这层该替它编一个地址的。
 */
export function rewriteDocHref(fromSlug: string, href: string): string {
  const raw = href.trim();
  if (!raw) return href;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw; // http: mailto: 等
  if (raw.startsWith('//') || raw.startsWith('/') || raw.startsWith('#')) return raw;

  // `#锚点` / `?查询` 与路径分开处理：路径要解析、尾巴要原样带过去
  const cut = raw.search(/[#?]/);
  const target = cut >= 0 ? raw.slice(0, cut) : raw;
  const tail = cut >= 0 ? raw.slice(cut) : '';

  const fromDir = fromSlug.includes('/') ? fromSlug.slice(0, fromSlug.lastIndexOf('/')) : '';
  const repoPath = normalizeRepoPath(`docs/${fromDir}/${target}`);
  if (!repoPath) return href;

  if (repoPath.startsWith('docs/')) {
    const slug = repoPath.slice('docs/'.length).replace(/\.md$/, '');
    if (BY_SLUG.has(slug)) return docHref(slug) + tail;
  }
  return `${REPO_BLOB}/${repoPath}${tail}`;
}

/** 解析 `a/b/../c` 这类相对路径（相对仓库根）。越出根返回 null。 */
function normalizeRepoPath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}
