// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/compiler-config.ts — 聊天编译与渲染共用的实例配置（纯数据、可克隆）
//
// 聊天只安装 minimal preset：编译出的静态展示组件（alert / badge / panel …）
// 与渲染端 `reactive-md/react/minimal` 的默认宿主是同一份 preset，两边 `config.key`
// 相同，文档不会在视图层因「编译配置 ≠ 渲染配置」降级。
//
// 只依赖 `reactive-md/sdk` 与 `reactive-md/presets/minimal`：无 React / DOM / window，
// 可以随 Worker 请求 structuredClone。不要在模块顶层 import `reactive-md/react/*`；
// 改这里的 preset 选择等于同时改编译、缓存与渲染身份，先核对 `react/minimal` 宿主。
// ─────────────────────────────────────────────────────────────────────────────

import { createLocalConfig } from 'reactive-md/sdk';
import { minimalPreset } from 'reactive-md/presets/minimal';

/** 聊天编译与渲染共用的实例配置（minimal preset 的静态展示组件）。 */
export const CHAT_RMD_COMPILE_CONFIG = createLocalConfig({ presets: [minimalPreset] });

/** 配置的语义标识；缓存与测试都从这里取，不另写版本字面量。 */
export const CHAT_RMD_COMPILE_CONFIG_KEY = CHAT_RMD_COMPILE_CONFIG.key;