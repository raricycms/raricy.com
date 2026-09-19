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
// 判定与闸门在 `blog-service.ts`（文件头的「可见性四条不变量」），不在这里。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三档，按「可见范围由小到大」排列。
 *
 * 这个顺序就是表单里选项的顺序，也是提示语的顺序 —— 别打乱。
 */
export const BLOG_VISIBILITIES = ['private', 'link', 'public'] as const;
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
  private: '仅站内可见',
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
  private: '仅站内',
  link: '凭链接',
  public: '已公开',
};

/**
 * 解析提交上来的可见性。
 *
 * 缺省 → 'private'：旧客户端（不带这个字段的表单 / bot）不得改变任何文章的对外状态。
 * 显式传了非白名单值 → null，由调用方报 400。**不静默丢弃** —— 调用方把 `publish`
 * 拼成 `pulbic` 却拿到一份「看着正常、其实存了 private」的结果，是最难查的那类问题
 * （与 `/api/blogs` 的 search_fields 白名单同一个口径）。
 */
export function parseVisibility(raw: unknown): BlogVisibility | null {
  if (raw === undefined || raw === null || raw === '') return 'private';
  return (BLOG_VISIBILITIES as readonly string[]).includes(raw as string)
    ? (raw as BlogVisibility)
    : null;
}
