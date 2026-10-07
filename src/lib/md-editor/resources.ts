// ─────────────────────────────────────────────────────────────────────────────
// md-editor/resources.ts —— 「插入引用」面板的五类资源词汇表（零 React、可单测）
//
// 【这一层管什么】每条资源的**读口、解析、能不能插、插什么**。组件只管画：
// 一个 modal、一个搜索框、一个列表。分开的理由是这里每一条都**错了不报错**：
//   · 读口写错 → 面板列的是别人的东西（或者列不出来），页面一切正常；
//   · 解析写松 → 少一列只是标题空着，看不出是解析错了；
//   · 插入语法写错 → 正文里留一段方括号原文，谁也不报错。
// 所以它们逐条落在这里，由 tests/unit/md-editor-resources.test.ts 钉住。
//
// 【插入语法一律从各自的 refs 模块取，不在本文件拼字面量】`[@<id>]` 按长度分流、
// `[@音频/<id>]` 是具名合集 —— 拼错一个字符就是「插进去不展开」。见
// content-refs.ts / audio-refs.ts / favorite-refs.ts 里各自的 token 构造。
//
// 【权限边界】五个读口都是**只列自己**（§4.1 表）：图床 / 音频 / 剪贴板 / 投票 /
// 收藏夹。面板不提供跨账号的资源广场；手动输入引用仍由正文读口各自判权。
// 收藏夹是唯一的例外 —— 私有收藏夹**没有句柄**（public_id 恒 NULL），
// 于是它列得出来却插不进去，理由写在行内（这是隐私设计，不是权限不足）。
//
// 【时间戳】`created_at` 是库里的形态（UTC+8 墙上时间贴 Z，见 src/lib/db-time.ts）。
// 显示一律**切字符串**，绝不 `new Date(...).toLocale*()` —— 那会把墙上时间再按
// 浏览器时区搬一次，东八区之外的读者看到的是差 8 小时的日期。
// ─────────────────────────────────────────────────────────────────────────────

import { AUDIO_REF_COLLECTION, audioRefToken } from '@/lib/audio-refs';
import { contentRefToken } from '@/lib/content-refs';
import { favoriteRefToken, isFavoriteId } from '@/lib/favorite-refs';
import { imageMarkdown } from './upload';

export type ResourceKind = 'image' | 'audio' | 'clipboard' | 'vote' | 'favorite';

export interface ResourceItem {
  /** 列表里的稳定键（React key；同类里 id 唯一）。 */
  key: string;
  /** 主标题。 */
  title: string;
  /** 副标题（时间 / 条数 / 类型）。 */
  subtitle: string;
  /** 要插进正文的原文；**null = 这一条不可插入**，原因见 reason。 */
  insert: string | null;
  /** 不可插入时给用户看的一句话。 */
  reason?: string;
  /** 缩略图（只有图床有）。 */
  thumb?: string;
  /** 角标：公开 / 私密 / 已锁定…… */
  badge?: string;
  /** 搜索命中的额外关键词（id 之类）。 */
  search: string;
}

export interface ResourceKindSpec {
  key: ResourceKind;
  /** 面板上的标签。 */
  label: string;
  /** 列表读口。 */
  endpoint: string;
  /** 空列表时那句话。 */
  empty: string;
  /** 面板底部那句权限边界。 */
  hint: string;
  /** 解析读口返回的报文 → 列表条目。异常形态一律跳过，不抛。 */
  parse: (payload: unknown) => ResourceItem[];
}

// ── 取值小工具 ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 行 id —— **数字与字符串都要收**。
 *
 * 五类的主键在库里都是字符串（收藏夹的 `Favorite.id` 是 UUID，另有 6 位数字的
 * `public_id` 才是对外把手 —— 别把两者看成一回事），所以这是条**防御性**归一化，
 * 不是「收藏夹是数字 id」。留着它的理由：id 的取法一旦认错，后果是**整类空掉**
 * —— 接口 200、报文里明明有数据、列表却是空的，看着像「我一个收藏夹都没有」，
 * 而页面上没有任何报错可供追查。数字/字符串两种形态都收，成本是两行。
 */
function asIdString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 从报文里取出某个数组字段；形态不对就是空数组（不抛）。 */
function takeArray(payload: unknown, field: string): Record<string, unknown>[] {
  const bag = asRecord(payload);
  const raw = bag ? bag[field] : null;
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * 库里那串 ISO → `2026-10-07 21:04`（**只切字符串，不做时区换算**，见文件头）。
 * 形态不对就返回空串 —— 少一个副标题远好过抛在渲染里。
 */
export function dbStamp(iso: unknown): string {
  const s = asString(iso);
  if (s.length < 16) return '';
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

const BADGE_PUBLIC = '公开';
const BADGE_PRIVATE = '私有';

// ── 五类 ────────────────────────────────────────────────────────────────────
//
// 顺序 = 面板上的标签顺序（与 docs/editor-plan.md §4.1 的表同序）。

export const RESOURCE_KINDS: readonly ResourceKindSpec[] = [
  {
    key: 'image',
    label: '图床',
    endpoint: '/api/images',
    empty: '你还没有上传过图片',
    // 图床的读口是 `GET /api/images`（自己的、未软删的、最新在前）。插进正文的是
    // **标准 Markdown**，不是 10 位 token —— 与上传插入的形状一致（§4.1）。
    hint: '只能选你自己上传的图片。插入的是标准 Markdown 图片语法；图本身仍按图床的读口判权，私有的图站外读不到。',
    parse(payload) {
      return takeArray(payload, 'images').flatMap((raw) => {
        const id = asString(raw.id);
        if (!id) return [];
        const filename = asString(raw.filename) || `${id}.png`;
        return [
          {
            key: id,
            title: filename,
            subtitle: dbStamp(raw.created_at),
            // 与上传那条路**同一个**构造（md-editor/upload.ts 的 imageMarkdown）：
            // 文件名后跟一个换行，换代前后正文里的样子逐字一致。
            insert: imageMarkdown(filename, `/api/images/${id}/raw`),
            thumb: `/api/images/${id}/raw`,
            badge: raw.is_public === true ? BADGE_PUBLIC : BADGE_PRIVATE,
            search: `${filename} ${id}`.toLowerCase(),
          },
        ];
      });
    },
  },
  {
    key: 'audio',
    label: '音频',
    endpoint: '/api/audio',
    empty: '你还没有上传过音频',
    hint: `只能选你自己上传的音频。插入的是 ${AUDIO_REF_COLLECTION}引用，发布后读者看到的是一个播放器。`,
    parse(payload) {
      return takeArray(payload, 'items').flatMap((raw) => {
        const id = asString(raw.id);
        if (!id) return [];
        const filename = asString(raw.filename) || id;
        return [
          {
            key: id,
            title: filename,
            subtitle: dbStamp(raw.created_at),
            insert: audioRefToken(id),
            badge: raw.is_public === true ? BADGE_PUBLIC : BADGE_PRIVATE,
            search: `${filename} ${id}`.toLowerCase(),
          },
        ];
      });
    },
  },
  {
    key: 'clipboard',
    label: '剪贴板',
    endpoint: '/api/clipboard',
    empty: '你还没有发布过云剪贴板',
    // 这句与剪贴板表单自己那段说明同一口径（UploadForm 的 publicity 提示）：
    // 私密剪贴板嵌进**对外公开**的博客后，站外读者看到的是原文。
    hint: '只能选你自己的云剪贴板。私密的嵌进对外公开的博客后，站外读者看到的是方括号原文。',
    parse(payload) {
      return takeArray(payload, 'clips').flatMap((raw) => {
        const id = asString(raw.id);
        if (!id) return [];
        const title = asString(raw.title) || id;
        return [
          {
            key: id,
            title,
            subtitle: dbStamp(raw.created_at),
            insert: contentRefToken(id),
            badge: raw.publicity === true ? BADGE_PUBLIC : '私密',
            search: `${title} ${id}`.toLowerCase(),
          },
        ];
      });
    },
  },
  {
    key: 'vote',
    label: '投票',
    endpoint: '/api/votes',
    empty: '你还没有创建过投票',
    // 预览是只读的（不绑提交处理器），发布后才有票可投 —— 这句是为了免得用户
    // 在预览里点不动而以为插坏了。
    hint: '只能选你自己创建的投票。预览里点不动（预览不发写请求），发布后读者才投得了票。',
    parse(payload) {
      return takeArray(payload, 'votes').flatMap((raw) => {
        const id = asString(raw.id);
        if (!id) return [];
        const title = asString(raw.title) || id;
        const options = typeof raw.option_count === 'number' ? raw.option_count : null;
        const total = typeof raw.total_votes === 'number' ? raw.total_votes : null;
        const parts = [dbStamp(raw.created_at)];
        if (options !== null) parts.push(`${options} 个选项`);
        if (total !== null) parts.push(`${total} 票`);
        return [
          {
            key: id,
            title,
            subtitle: parts.filter(Boolean).join(' · '),
            insert: contentRefToken(id),
            badge: raw.is_locked === true ? '已锁定' : undefined,
            search: `${title} ${id}`.toLowerCase(),
          },
        ];
      });
    },
  },
  {
    key: 'favorite',
    label: '收藏夹',
    endpoint: '/api/favorites',
    empty: '你还没有收藏夹',
    // ★ 这一类的判据与其余四类不同：能不能插**不看权限，看有没有句柄** ★
    // 私有收藏夹的 public_id 恒为 NULL（favorite-service.ts 的不变量），
    // 所以它没有可写进正文的 id —— 插一个假的只会得到一个不展开的 token。
    hint: '只有公开的收藏夹能插进正文：私有的没有对外 ID，插进去谁也读不到。',
    parse(payload) {
      return takeArray(payload, 'favorites').flatMap((raw) => {
        const rowId = asIdString(raw.id);
        const publicId = asString(raw.public_id);
        if (!rowId) return [];
        const title = asString(raw.title) || rowId;
        const count = typeof raw.item_count === 'number' ? raw.item_count : null;
        const subtitle = [dbStamp(raw.created_at), count === null ? '' : `${count} 篇`]
          .filter(Boolean)
          .join(' · ');
        const insertable = raw.is_public === true && isFavoriteId(publicId);
        return [
          {
            key: rowId,
            title,
            subtitle,
            insert: insertable ? favoriteRefToken(publicId) : null,
            reason: insertable ? undefined : '私有收藏夹没有对外 ID，不能插进正文',
            badge: insertable ? BADGE_PUBLIC : '私有',
            search: `${title} ${rowId} ${publicId}`.toLowerCase(),
          },
        ];
      });
    },
  },
];

/** 按 key 取一类（面板切标签时用）。 */
export function resourceKind(key: ResourceKind): ResourceKindSpec {
  const found = RESOURCE_KINDS.find((s) => s.key === key);
  // 五类都在表里，找不到只可能是类型被绕过 —— 抛出来好过静默给一个空面板
  if (!found) throw new Error(`unknown resource kind: ${key}`);
  return found;
}

/**
 * 本地搜索。**在已取得的列表上过滤**（§4.1：这些读口没有服务端分页与搜索），
 * 空查询返回全量。匹配标题与 id，都不区分大小写。
 */
export function filterResourceItems(items: ResourceItem[], query: string): ResourceItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.search.includes(q));
}
