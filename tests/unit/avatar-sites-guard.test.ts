// ─────────────────────────────────────────────────────────────────────────────
// avatar-sites-guard.test.ts —— 静态检查：头像只能走共用组件，URL 只有一处口径
//
// 【绊的是什么】全站有 16 个文件渲染头像（20px 到 120px）。此前每处都自己拼
// `/api/avatar/<id>`、自己记得写 `border-radius: 8%`。头像框要显示得到处都是，
// 所以必须先收敛 —— 而收敛之后真正危险的是**有人又手写回去**：
//
//     <img src={`/api/avatar/${id}`} />        ← 这一处永远不会有头像框
//
// 它**不报错**：页面照常渲染，只是那个人没有框，没有日志、没有 500。tsc 管不着
//（类名与 URL 都是字符串），单测也管不着（除非恰好覆盖到那一处）。跟 db-time-guard /
// blog-visibility-guard / anonymous-read-guard 同属一类：**只有静态检查能钉住**。
//
// 【两道判据】
//   1. `/api/avatar/` 这个字面量全仓只允许出现在 src/lib/avatar-refs.ts 一处。
//      别的地方一律用 avatarUrl(id) 或 <Avatar>（组件内部就是调它）。
//   2. 落点台账里的每个文件都必须真的用着 `<Avatar`。台账是**正向**的：它回答
//      「该有头像的地方是不是都收敛了」；判据 1 是**反向**的：它回答「有没有人绕开」。
//      两条都必要 —— 只留判据 1，一个从没写过头像的新页面不会被发现；
//      只留判据 2，手写模板串的那一处照样绿。
//
// ⚠️ **它是绊线，不是证明器**：台账里逐行列出的文件是**手工维护**的。新增一个
//    渲染头像的页面时，这里要添一行 —— 否则那个页面既不在台账里、也不违反判据 1，
//    于是它静默地永远没有框。这一点没有更好的自动化办法（组件的 props 是运行时的）。
//
// ── 【为什么注释要单独处理】──────────────────────────────────────────────────
// 本仓的注释里**故意**写着 `/api/avatar/<id>` 当反例（avatar.ts 的文件头、
// oauth/userinfo 的说明、ChatSidebar 与 CheckinCard 里解释旧写法的段落）。
// 不剥注释的话，这条守卫会把自己的文档判成违规 —— 而它一旦天天误报，最终会被人关掉。
//
// ⚠️ 剥离器必须**认得字符串字面量**：模板串 `` `/api/avatar/${id}` `` 正是我们要抓的
//    东西，把它当成「注释的开头」吃掉就等于瞎了。所以下面是一个三态的扫描器
//    （普通 / 注释 / 字符串），不是一句正则。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** 拼头像 URL 的**唯一**允许处。 */
const URL_OWNER = 'src/lib/avatar-refs.ts';

/** 全仓唯一的头像 URL 前缀字面量。 */
const AVATAR_URL_RE = /\/api\/avatar\//;

/**
 * 头像落点台账（**组件**档）—— 每个用 `<Avatar>` 渲染头像的文件。
 *
 * ⚠️ **手工维护**。新增渲染头像的页面/组件时在这里添一行，否则那一处永远不会被
 * 这条守卫覆盖到（见文件头）。顺序按「服务端组件 / 客户端组件 / 非 DOM」分组。
 *
 * 另有一档 `AVATAR_DOM_SITES`（见下）—— 那张表里的文件用不了这个组件。
 */
const AVATAR_SITES = [
  // ── 服务端组件 ──
  'src/app/components/Navbar.tsx', // 顶栏用户下拉（32px）
  'src/app/u/[id]/page.tsx', // 个人主页大图（120px）
  'src/app/blog/page.tsx', // 博客列表作者（20px）
  'src/app/blog/[id]/page.tsx', // 文章详情作者（20px）
  'src/app/explore/page.tsx', // 对外探索页作者（20px，刻意不作链接）
  'src/app/admin/users/page.tsx', // 后台用户卡片（28px）
  'src/app/components/CheckinCard.tsx', // 签到天数榜（32px）

  // ── 客户端组件 ──
  'src/app/components/CommentSection.tsx', // 博客评论作者（24px）
  'src/app/components/FeedButton.tsx', // 点赞者 / 投喂者弹窗名单（内联 32px）
  'src/app/chat/ChatMessageItem.tsx', // 讨论消息作者（34px，<button>）
  'src/app/chat/ChatSidebar.tsx', // 频道列表（34px）
  'src/app/chat/ChatApp.tsx', // 私聊标题栏（32px）
  'src/app/chat/NewChatModal.tsx', // 发起私聊搜索结果（32px）
  'src/app/fish/market/RecipientPicker.tsx', // 转账选人（32px）
  'src/app/fish/market/TransferPanel.tsx', // 转账面板 + 二次确认（36 / 44px）
  'src/app/fish/market/ShopPanel.tsx', // 商城预览：把商品框叠在访问者自己的头像上（52px）
  'src/app/fish/PayForm.tsx', // 收银台 / 收款页的收款人（36px）
  'src/app/components/UserPicker.tsx', // 发用户名片的选人列表（32px）
];

/**
 * 头像落点台账（**DOM 构造**档）—— 用不了 `<Avatar>` 组件的那些落点。
 *
 * 【为什么会有这一档】`<Avatar>` 是 React 组件，而用户正文那两条管线（讨论 / 评论）
 * 的产物是**字符串**（`render()` 最后 `return holder.innerHTML`），里面塞不进组件 ——
 * 用户名片只能像 `[@10位图床图]` / 表情那样，在净化之后用 `createElement` 亲手搭出
 * 与 `<Avatar>` **逐字同构**的 DOM（见 src/lib/user-refs.ts 的 buildUserCardElement）。
 *
 * 【判据为什么不一样】这一档的判据是「文件里出现 `avatar__frame`」，而不是「用了
 * `<Avatar>`」—— 台账真正要保的不变量是**这一处会不会有头像框**，不是「用了哪个 API」。
 * 只写 `<img src={avatarUrl(id)}>` 而忘了框，本来正是这张表要拦的东西。
 *
 * ⚠️ 同样**手工维护**。新增一处 DOM 构造的头像落点时在这里添一行。
 */
const AVATAR_DOM_SITES = [
  'src/lib/user-refs.ts', // 用户名片 `[@用户/<用户名>]`（行内胶囊，1.4em）
];

/**
 * 剥掉注释，**保留换行**（行号不能漂 —— 报错要指得到行）。
 *
 * 三态扫描：普通代码 / 注释 / 字符串字面量（`'` `"` `` ` ``）。
 * 字符串态是必须的：模板串 `` `/api/avatar/${id}` `` 正是判据 1 要抓的东西，
 * 若把 `//` 的判定做在字符串之前，`'https://…'` 这类会吃掉半行，
 * 而我们要抓的模板串**可能就在那半行里**（假阴性 = 守卫瞎了）。
 *
 * 转义用「前一个字符是不是反斜杠」近似判断 —— 对 TS 源码足够，
 * 且它出错的方向是「少数几个字符被当成字符串」，不会把代码吃成注释。
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const escaped = i > 0 && src[i - 1] === '\\';

    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      } else out += ' ';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'tpl') {
      const closer = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
      out += c;
      if (c === closer && !escaped) mode = 'code';
      i += 1;
      continue;
    }

    // mode === 'code'
    if (c === '/' && n === '/') {
      mode = 'line';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      mode = 'block';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'") mode = 'sq';
    else if (c === '"') mode = 'dq';
    else if (c === '`') mode = 'tpl';
    out += c;
    i += 1;
  }
  return out;
}

/** 扫全仓源码（已剥注释），返回违规处的 `相对路径:行号: 内容`。 */
function scan(text: string, rel: string): string[] {
  const hits: string[] = [];
  stripComments(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (AVATAR_URL_RE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('剥注释：认得出字符串，也只剥注释', () => {
  // ★ 产出自检 ★ —— 剥离器写错时（把字符串当注释 / 把注释当代码），下面那条全仓
  // 扫描会**一片绿**，而它其实什么都没扫到、或者扫到了一堆假阳性。
  it('★ 自检：注释里的违规串被剥掉，代码里的（含模板串）留着', () => {
    const sample = [
      '// 反例：<img src={`/api/avatar/${id}`} />',
      '/* 块注释里的 /api/avatar/ 也该被剥掉 */',
      '/* 跨行块注释第一行 /api/avatar/',
      '   第二行还有 /api/avatar/ */',
      'const a = `/api/avatar/${id}`;',
      "const b = '/api/avatar/x';",
    ].join('\n');
    const hits = scan(sample, 'sample.ts');
    // 只有最后两行是代码
    expect(hits.length, `应当只命中两行代码，实际：\n${hits.join('\n')}`).toBe(2);
    expect(hits[0]).toContain('const a');
    expect(hits[1]).toContain('const b');
  });

  it('自检：行号不漂（剥注释保留换行）', () => {
    const sample = ['// 一', '/* 二', '三 */', 'const x = `/api/avatar/y`;'].join('\n');
    expect(scan(sample, 's.ts')[0]).toMatch(/^s\.ts:4:/);
  });

  it('自检：字符串里的 // 不会被当成注释开头（否则会吃掉同一行后半段的违规串）', () => {
    const sample = "const u = 'https://example.com'; const v = `/api/avatar/${id}`;";
    expect(scan(sample, 's.ts').length, '同一行后半段的模板串必须被看见').toBe(1);
  });

  it('自检：整段被注释掉的代码命中 0（行注释与块注释两种都要剥干净）', () => {
    const sample = [
      '// const a = `/api/avatar/a`;',
      '/*',
      '  const b = `/api/avatar/b`;',
      '  const c = `/api/avatar/c`;',
      '*/',
      'const live = 1;',
    ].join('\n');
    expect(scan(sample, 's.ts'), '块注释里那两行也必须被剥掉').toEqual([]);
  });
});

describe('★ 判据 1：拼头像 URL 只有一处口径', () => {
  it('全仓扫描：/api/avatar/ 只出现在 avatar-refs.ts', () => {
    const hits = sourceFiles(SRC)
      .flatMap((f) => scan(fs.readFileSync(f, 'utf8'), rel(f)))
      .filter((h) => !h.startsWith(`${URL_OWNER}:`));

    expect(
      hits,
      '拼头像地址请用 src/lib/avatar-refs.ts 的 avatarUrl(id)，渲染头像请用\n' +
        'src/app/components/Avatar.tsx 的 <Avatar>。手写模板串的那一处**永远不会有\n' +
        '头像框**，而且不报错（页面照常渲染，只是那个人没有框）。违规处：\n  ' +
        (hits.join('\n  ') || '（无）')
    ).toEqual([]);
  });

  it('★ 扫描面自检：真的扫到了源码（路径写错时上面那条会假绿）', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'src/ 下应当有大量 ts/tsx').toBeGreaterThan(100);
    // 唯一允许拼 URL 的那个文件必须在扫描面内 —— 否则上面那条的「排除它」是空操作
    expect(files.some((f) => rel(f) === URL_OWNER)).toBe(true);
  });

  it('avatar-refs.ts 自己确实定义了那个前缀（否则上面那条排除它就成了放行一切）', () => {
    const src = fs.readFileSync(path.join(ROOT, URL_OWNER), 'utf8');
    expect(stripComments(src)).toMatch(AVATAR_URL_RE);
  });
});

describe('★ 判据 2：落点台账里的每一处都真的在用 <Avatar>', () => {
  it('台账里的文件都存在（两档一起查）', () => {
    const missing = [...AVATAR_SITES, ...AVATAR_DOM_SITES].filter(
      (f) => !fs.existsSync(path.join(ROOT, f))
    );
    expect(
      missing,
      '台账里列的文件不存在了 —— 要么是文件被挪走/改名（请更新台账），' +
        '要么是这条守卫正在给一个已经不存在的落点背书：\n  ' + missing.join('\n  ')
    ).toEqual([]);
  });

  it('台账里每个文件都含 <Avatar（漏了就说明那一处还没收敛）', () => {
    const missing = AVATAR_SITES.filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      // `<AvatarMenu` 是「点头像弹出的选项框」，不是头像本身 —— 必须排除，
      // 否则讨论区那几个只用了 AvatarMenu 的文件会被误判成已收敛
      return !/<Avatar(?!Menu)/.test(src);
    });
    expect(
      missing,
      '这些文件在头像落点台账里，却没有用 <Avatar>：\n  ' + missing.join('\n  ')
    ).toEqual([]);
  });

  it('台账没有重复项（重复会让「新落点没登记」这件事被掩盖）', () => {
    const all = [...AVATAR_SITES, ...AVATAR_DOM_SITES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('★ 两张台账不重叠（同一个文件同时出现在两档，说明它既用了组件又在手搭 DOM）', () => {
    const overlap = AVATAR_SITES.filter((f) => AVATAR_DOM_SITES.includes(f));
    expect(overlap, '同一处头像有两套实现 —— 迟早只有一套会被改').toEqual([]);
  });

  it('自检：正则认得出 <Avatar 但认不出 <AvatarMenu', () => {
    expect(/<Avatar(?!Menu)/.test('<Avatar userId={x} />')).toBe(true);
    expect(/<Avatar(?!Menu)/.test('<Avatar\n  userId={x}\n/>')).toBe(true);
    expect(/<Avatar(?!Menu)/.test('<AvatarMenu open={x} />')).toBe(false);
  });
});

describe('★ 判据 2（DOM 档）：手搭头像的那几处必须真的有框', () => {
  it('每个文件都出现 avatar__frame（这才是台账要保的东西）', () => {
    // 「用了 <Avatar>」在 DOM 档是做不到的，所以判据换成「框在不在」。
    // 少写那个 img：这一处**永远没有头像框**，不报错、没有日志。
    const missing = AVATAR_DOM_SITES.filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      return !/avatar__frame/.test(src);
    });
    expect(missing, `这些文件在 DOM 档里，却没有渲染头像框：\n  ${missing.join('\n  ')}`).toEqual(
      []
    );
  });

  it('每个文件都走 avatarUrl()（判据 1 的反向保险：这里没写模板串）', () => {
    // 判据 1 已经全仓拦着 `/api/avatar/` 字面量了，这条是**正向**的：确认它是靠
    // 那个唯一出口拼出来的，而不是干脆没拼（比如从 DTO 里直接拿了一个完整 URL）。
    const missing = AVATAR_DOM_SITES.filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      return !/avatarUrl\(/.test(src);
    });
    expect(missing, `这些文件在 DOM 档里，却没有用 avatarUrl()：\n  ${missing.join('\n  ')}`).toEqual(
      []
    );
  });

  it('★ 两档的判据互不通用（组件档的文件不该被 DOM 档的断言误判）', () => {
    // 自检：拿一个组件档的文件过 DOM 档的判据，应当判红 —— 否则说明这个循环是空的
    const jsx = stripComments(fs.readFileSync(path.join(ROOT, 'src/app/chat/ChatMessageItem.tsx'), 'utf8'));
    expect(/avatar__frame/.test(jsx)).toBe(false);
    expect(/<Avatar(?!Menu)/.test(jsx)).toBe(true);
  });
});
