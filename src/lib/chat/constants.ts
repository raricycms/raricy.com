// constants.ts — 讨论域共享常量：频道类型、每页条数、core+ 角色表
//
// 唯一真相：频道 kind 的字面量与首次拉取条数只在这里定义，别的 chat/ 模块一律
// import 本文件，不重复写 'lobby' / 'direct'（写歪不报错，只会静默判错频道类型）。
// 字数上限是前后端共用的纯数据，定义在 chat-shared.ts（客户端组件 import 服务端
// 模块会把 auth.ts → next/headers 打进浏览器包）；barrel 已把它们带出去，服务端
// 调用方照旧从 chat-service 导入即可，**别再在这里重新定义一份** —— 曾经就是因此
// 让 ChatApp 抄了一份硬编码副本，改常量不会跟着变。
// CORE_ROLES 只用于服务端权限判定，仅供 chat/ 内部使用，不从 barrel 导出。

export const CHAT_KIND_LOBBY = 'lobby';
export const CHAT_KIND_DIRECT = 'direct';
export const CHAT_INITIAL_LIMIT = 50; // 首次加载 / 每页拉取条数
/** 能进讨论的角色（core 及以上）；各处 `.includes(role)` 共用这一份名单。 */
export const CORE_ROLES = ['core', 'admin', 'owner'];
