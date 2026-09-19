// ─────────────────────────────────────────────────────────────────────────────
// blog-visibility.ts — 文章对外可见性的**词汇表**（三档的名字、白名单、解析、人话标签）
//
// 【为什么单独一个文件】发文表单（`src/app/components/BlogForm.tsx`）是客户端组件，
// 它要把三档渲染成选项；而 `blog-service.ts` 拖着 prisma，**不能进客户端包**。
// 词汇是这一整套设计里唯一两端都要用到的部分，所以它必须住在一个零依赖的模块里
// —— 否则前端就只能手抄一份清单，而手抄的那份会在加第四档时静默漏掉（表单少一个
// 选项，不报错，只是那一档从此在界面上不可达）。
// type-only 的 `import type` 帮不上忙：它只擦类型，擦不掉运行时要用到的数组。
//
// ── 【第一档的名叫 'internal'，不叫 'private'（2026-09 改名，迁移 17）】──────────
//
// 'private' 在本仓库**已经是另一个东西的名字**：
//   · 云剪贴板的「不公开」= 只有作者本人（和站长）：`!isPublic && authorId !== viewerId`
//   · 收藏夹的「私密」   = 只有创建者本人：`public_id` 恒为 NULL（没有句柄，不是藏起来）
// 而这一档的语义是**所有 core+ 成员都能看** —— 它是「站内」，不是「私密」。
// 同一个词指两件事，读代码的人必然先误解一次，而误解的代价正好落在「什么会对外可见」上。
//
// 人话标签其实一直是对的（`仅站内可见` / `仅站内`）—— 这次只是把机器值对齐到它本来的意思。
//
// ⚠️ **改名之后 `visibility !== 'private'` 会对每一行都成立**（没有行再是 'private'），
// 于是「不等于最不可见的那一档」会静默变成「全部对外可见」。所以旧拼写必须继续被拦着 ——
// `tests/unit/blog-visibility-guard.test.ts` 的两组 BANNED 里，一组是新名、一组是旧名。
//
// 判定与闸门在 `blog-service.ts`（文件头的「可见性四条不变量」），不在这里。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三档，按「可见范围由小到大」排列。
 *
 * 这个顺序就是表单里选项的顺序，也是提示语的顺序 —— 别打乱。
 *
 * `internal` 读作「站内」：不是「作者私藏」，是「这一档不对外，站内成员照常看得到」。
 */
export const BLOG_VISIBILITIES = ['internal', 'link', 'public'] as const;
export type BlogVisibility = (typeof BLOG_VISIBILITIES)[number];

/** 拿到链接的任何人（含未登录访客）可读。 */
export const EXTERNAL_VISIBILITIES = ['link', 'public'] as const;
/** 可列举、可索引 —— 只有 public。link 读得到，但不进 sitemap。 */
export const INDEXABLE_VISIBILITIES = ['public'] as const;

/**
 * 人话说法。给用户看的地方一律用它 —— 别把 'link' 这种机器值塞进通知或界面。
 * 表单一句话解释见 BlogForm；这里是**短语**，用在「文章已编辑」的变更明细里。
 */
export const VISIBILITY_LABEL: Record<BlogVisibility, string> = {
  internal: '仅站内可见',
  link: '凭链接可读',
  public: '对外公开',
};

/**
 * 列表卡片上的**短**标记（`VISIBILITY_LABEL` 是短语，塞不进一个小胶囊）。
 *
 * 与 `VISIBILITY_LABEL` 放在一起、同样覆盖三档：加第四档时**两张表都会缺键**，
 * tsc 当场报错（`Record<BlogVisibility, string>` 是穷尽的），而不是界面上少一个标记
 * 却不报错。这正是把它们放进这个零依赖模块的理由 —— 服务端与客户端读同一份。
 */
export const VISIBILITY_BADGE: Record<BlogVisibility, string> = {
  internal: '仅站内',
  link: '凭链接',
  public: '已公开',
};

/**
 * 解析提交上来的可见性。
 *
 * 缺省 → `'internal'`：旧客户端（不带这个字段的表单 / bot）不得改变任何文章的对外状态。
 * 显式传了非白名单值 → null，由调用方报 400。**不静默丢弃** —— 调用方把 `public`
 * 拼成 `pulbic` 却拿到一份「看着正常、其实还锁在站内」的结果，是最难查的那类问题
 * （与 `/api/blogs` 的 search_fields 白名单同一个口径）。
 *
 * ⚠️ 改名（private → internal）之后，**旧值 `'private'` 也落进「非白名单 → null」**，
 * 于是调用方拿到 400 且错误信息里列着三个合法值。这是有意的：一个还在发 `'private'`
 * 的调用方必须**当场被告知**，而不是让它以为自己改对了（那条请求的真实效果取决于
 * 它本来想改成哪一档，猜错就是把文章静默放出去或锁回来）。
 */
export function parseVisibility(raw: unknown): BlogVisibility | null {
  if (raw === undefined || raw === null || raw === '') return 'internal';
  return (BLOG_VISIBILITIES as readonly string[]).includes(raw as string)
    ? (raw as BlogVisibility)
    : null;
}
