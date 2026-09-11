// ─────────────────────────────────────────────────────────────────────────────
// types.ts —— 运维 CLI 的命令元数据契约
//
// 【为什么要有这份元数据】两个前端（命令式 argv / 交互式向导）与 `--help` 全部由它
// 生成。新增一条命令 = 往 registry 加一条，帮助与向导**自动**跟上 ——
// 不存在「加了命令忘了更新文档」这种漂移（docs/cli.md 现在就有一节讲限频的
// 内容是失实的，正是这种漂移的产物）。
//
// 参数的校验（validate）也只写一份，两条路径共用：命令式与向导走的是同一个函数，
// 不存在「命令行挡住了、向导没挡住」。
//
// ⚠️ 本文件只放类型。运行时值（尤其是 Prisma）一律不在这里 import —— 顶层
// `--help` 必须不加载 Prisma 也能渲染（见 scripts/cli.ts 的说明）。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import type { SafeUser } from '../../src/lib/auth';

/** 参数解析成什么类型。向导据此选默认的提问方式。 */
export type ArgKind = 'string' | 'int' | 'number' | 'boolean';

/** 解析后的参数表。repeatable 的参数是 string[]。 */
export type Args = Record<string, string | number | boolean | string[] | undefined>;

/** 菜单 / 候选列表里的一个选项。 */
export interface Choice {
  /** 最终写进 args 的值 —— 实体类参数就是它的 id / 枚举字面量。 */
  value: string;
  /** 列表里显示的一行。 */
  label: string;
  /** 右侧灰字补充。 */
  hint?: string;
}

/**
 * 「先搜后选」的数据源 —— 交互模式专用。
 *
 * 命令式前端**永不调用它**：`blog restore <id>` 一发即走。脚本要发现 id 就
 * `blog search --json | jq`，JSON 契约才是脚本的桥。
 */
export interface SearchSource {
  /** 关键词 → 候选（≤20 条）。 */
  search: (query: string) => Promise<Choice[]>;
  /** 关键词为空时的默认候选（例如「最近 20 条」），让操作者不输入也能选。 */
  initial?: () => Promise<Choice[]>;
  /** 关键词为空且没有 initial 时给用户看的一句提示。 */
  emptyHint?: string;
  /** 候选列表为空时，是否允许把输入的关键词原样当值提交。默认 false。 */
  allowFreeTextFallback?: boolean;
}

/** 交互模式下某个参数的收集方式。 */
export type PromptSpec =
  | { type: 'input'; placeholder?: string }
  | { type: 'password' }
  | { type: 'number'; min?: number; max?: number; integer?: boolean }
  | { type: 'confirm' }
  | { type: 'select'; choices: Choice[]; pageSize?: number }
  | { type: 'search'; source: SearchSource };

/** 一个命令参数的完整声明。 */
export interface ArgSpec {
  /** 内部键名（camelCase）→ ctx.args[name]。 */
  name: string;
  /** ['--reason','-r']；空数组 = 纯位置参数（与 positional 二选一）。 */
  flags: string[];
  /** 0-based 位置序号；undefined = 只能由 flag 提供。 */
  positional?: number;
  /** flag 可重复 → 值为 string[]（如 --redirect-uri）。只允许加在 flag 上。 */
  repeatable?: boolean;
  /** 解析类型，默认 'string'。 */
  kind?: ArgKind;
  /** 交互模式的提问语（中文）。 */
  label: string;
  /** --help 里的说明（中文）。 */
  help: string;
  required?: boolean;
  /** 条件必填（如 appeal decide 的 note 在 reject 时必填）。 */
  requiredIf?: (args: Args) => boolean;
  /** 缺省值；命令式与向导都会在参数缺席时用它。 */
  defaultValue?: string | number | boolean;
  /** 交互模式的收集方式；缺省按 kind 推断。 */
  prompt?: PromptSpec;
  /**
   * 值域校验。返回中文错误信息或 null。**两条前端共用这一份**。
   * raw 是原始字符串（命令式）或向导收集到的值转成的字符串。
   */
  validate?: (raw: string, args: Args) => string | null;
  /** 确认屏回显该参数时打码（如 --password）。 */
  secret?: boolean;
  /** 只进 --help，向导跳过（历史兼容参数）。 */
  helpOnly?: boolean;
}

/** 表格列声明。 */
export interface ColumnSpec {
  key: string;
  title: string;
  align?: 'left' | 'right';
  /** 显示宽度上限（按显示宽度算，不是 String.length）。超了截断补 '…'。 */
  maxWidth?: number;
}

/** 命令的人读输出形态。 */
export type OutputFormat =
  | { kind: 'text' }
  | { kind: 'kv' }
  | { kind: 'table'; columns: ColumnSpec[]; rowsKey: string; emptyText?: string };

/** 命令返回的东西。 */
export interface CmdOutput {
  /** 人读输出（已经渲染好的行）。--json 模式下会被抑制。 */
  lines?: string[];
  /** --json 的结构化载荷。 */
  json?: unknown;
  /** 绿色补充行。 */
  notes?: string[];
  /** 黄色警告行（--json 模式下走 stderr，保证 stdout 只有 JSON）。 */
  warnings?: string[];
}

/** 命令失败的统一形态。exitCode 对齐 Flask：1 参数/用户错误，2 账户服务同步失败。 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly details: string[];
  constructor(message: string, exitCode = 1, details: string[] = []) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** 危险等级。destructive / irreversible 需要确认（或显式 --yes）。 */
export type Danger = 'safe' | 'destructive' | 'irreversible';

/** 菜单分组。新增分组要同时加到 GROUP_LABELS。 */
export type GroupId =
  | 'roles'
  | 'users'
  | 'blogs'
  | 'comments'
  | 'clips'
  | 'votes'
  | 'images'
  | 'invites'
  | 'fish'
  | 'audit'
  | 'appeals'
  | 'oauth'
  | 'stats';

export const GROUP_LABELS: Record<GroupId, string> = {
  roles: '角色',
  users: '用户',
  blogs: '博客',
  comments: '评论',
  clips: '云剪贴板',
  votes: '投票',
  images: '图床',
  invites: '邀请码',
  fish: '小鱼干',
  audit: '审计日志',
  appeals: '申诉',
  oauth: 'OAuth 应用',
  stats: '站点概览',
};

/** 输出出口。命令**绝不**自己拼 ANSI 或直接写 process.stdout。 */
export interface Output {
  /** 已上色（或按开关降级为无色）的一行，写 stdout。 */
  line(s: string): void;
  /** 写 stderr。 */
  error(s: string): void;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  dim(s: string): string;
  /** 终端宽度（拿不到时退化为 80）。 */
  width(): number;
}

/** 命令执行上下文。 */
export interface Ctx {
  /** 用户实际敲的参数（已解析、已校验）。 */
  args: Args;
  /** 需要审计主体的命令才有；只读命令恒为 null。 */
  actor: SafeUser | null;
  prisma: PrismaClient;
  io: Output;
}

/** 一条命令的完整声明。 */
export interface CommandSpec {
  /** 命令路径，空格分隔，至少两段：'blog search'。第一段即菜单分组。 */
  name: string;
  /** 一句话说明（菜单与 --help 共用）。 */
  summary: string;
  /** 更长的说明（--help 详细）。 */
  details?: string;
  group: GroupId;
  args: ArgSpec[];
  /** 不写库 → 不需要审计主体、不需要确认。 */
  readOnly?: boolean;
  /** 会写审计日志 → 需要解析一个真实站长当主体（外键约束，不能伪造）。 */
  needsActor?: boolean;
  /** 危险等级；非 safe 需要确认或 --yes。 */
  danger?: Danger;
  /**
   * 确认屏要显示的「即将发生的变更」。**必须是只读的** —— 它在确认闸之前跑，
   * 写库绝不允许发生在这里。抛 CliError 即视为预检失败（先于 --yes 闸报错）。
   */
  describe?: (ctx: Ctx) => Promise<string[]>;
  output?: OutputFormat;
  /** 交互菜单里的排序权重，小的在前。 */
  order?: number;
  run: (ctx: Ctx) => Promise<CmdOutput>;
}
