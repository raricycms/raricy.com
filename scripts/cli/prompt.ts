// ─────────────────────────────────────────────────────────────────────────────
// prompt.ts —— 交互式提问的唯一出口
//
// 【为什么要有这层接口】向导的全部逻辑（collectArgs / 菜单循环 / 确认闸）都只依赖
// Prompter 接口，不直接碰 @inquirer/prompts。好处有二：
//   1. 可以用假 Prompter 把整条向导流程跑进单测，不需要 TTY、不需要模拟终端转义
//   2. 万一哪天要换掉 inquirer（或换回 node:readline），只改本文件
//
// 【Ctrl-C】inquirer 在 Ctrl-C 时抛 name === 'ExitPromptError' 的错误。那不是崩溃，
// 而是「用户取消了本次操作」—— 由向导捕获、回到菜单。isExitPromptError() 是判定。
// ─────────────────────────────────────────────────────────────────────────────

import { confirm, input, number as numberPrompt, password, select } from '@inquirer/prompts';
import { NAV_BACK, NAV_CANCEL, type Choice } from './types';

/** 自由文本输入时，用户可以打这两个约定来导航。 */
const BACK_TOKEN = ':b';
const CANCEL_TOKEN = ':q';
const NAV_HINT = '（:b 返回上一步，:q 回主菜单）';

/** 菜单里固定加在最前面的两个导航项。 */
export const NAV_CHOICES: Choice[] = [
  { value: NAV_BACK, label: '← 返回上一步' },
  { value: NAV_CANCEL, label: '✕ 取消本次操作' },
];

export function isNav(v: string): boolean {
  return v === NAV_BACK || v === NAV_CANCEL;
}

/** inquirer 的 Ctrl-C。捕获它 = 干净取消，不是崩溃。 */
export function isExitPromptError(e: unknown): boolean {
  return e instanceof Error && e.name === 'ExitPromptError';
}

export interface Prompter {
  /** y/N 确认。默认 false —— 裸回车即中止。 */
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  /** 文本输入。返回 NAV_BACK / NAV_CANCEL 表示用户要求导航。 */
  text(message: string, opts?: { defaultValue?: string; placeholder?: string }): Promise<string>;
  /** 数字输入。用户直接回车（没输）时返回 NaN，由调用方按校验规则要求重填。 */
  num(message: string, opts?: { defaultValue?: number }): Promise<number>;
  /** 单选。nav 为 true 时在最前面插入「返回上一步 / 取消」。 */
  pick(message: string, choices: Choice[], opts?: { pageSize?: number; nav?: boolean }): Promise<string>;
  /** 密码输入（掩码 + 二次确认）。 */
  secret(message: string): Promise<string>;
}

export function createPrompter(): Prompter {
  return {
    confirm: (message, defaultValue = false) => confirm({ message, default: defaultValue }),

    async text(message, opts) {
      // v7 的 input 没有 placeholder 选项，示例文本并进提示语里
      const example = opts?.placeholder ? `（例如 ${opts.placeholder}）` : '';
      const v = await input({
        message: `${message}${example} ${NAV_HINT}`,
        default: opts?.defaultValue,
      });
      const t = v.trim();
      if (t === BACK_TOKEN) return NAV_BACK;
      if (t === CANCEL_TOKEN) return NAV_CANCEL;
      return v;
    },

    async num(message, opts) {
      const v = await numberPrompt({ message, default: opts?.defaultValue });
      // 用户什么都没输时 inquirer 返回 undefined；交给调用方的校验循环去追问
      return v ?? NaN;
    },

    async pick(message, choices, opts) {
      const all = opts?.nav === false ? choices : [...NAV_CHOICES, ...choices];
      return select({
        message,
        choices: all.map((c) => ({ name: c.hint ? `${c.label}  ${c.hint}` : c.label, value: c.value })),
        pageSize: opts?.pageSize ?? 12,
      });
    },

    secret: (message) => password({ message, mask: '*' }),
  };
}
