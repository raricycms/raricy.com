// ─────────────────────────────────────────────────────────────────────────────
// scroll-activity.ts — 聊天页面「正在快速滚动」的进程内信号（客户端模块级订阅器）
//
// 职责只有一条：把滚动宿主的瞬时活动状态广播给编译链路的消费者
// （ChatRmdProvider → ChatCompileManager.setScrolling）。快速滚动时暂停新编译
// 任务的派发，减少滚动期间的主线程提交；不取消在途编译，也不碰滚动逻辑本身。
//
// 规则：
//   · 只在状态**变化**时通知订阅者；同一值重复 set 不触发；
//   · 单个订阅者抛错不影响其他订阅者（与 Manager 的 notify 同口径）；
//   · 模块顶层不访问 window / document，SSR import 安全（服务端状态永远为 false）；
//   · 订阅不回放当前值：调用方在页面生命周期内常驻订阅，变化时会收到；真正的
//     订阅者（ChatRmdProvider）在滚动开始前就已挂载。
//
// 调用方纪律：滚动状态的生产者在卸载 / 中止滚动检测时必须收尾为
// `setChatScrollActive(false)`。模块级状态跨路由 remount 存活，残留 true 会让
// 下一次「开始滚动」因值未变化而不通知，新编译器也就不会暂停。
//
// 这是页面内信号，不走 Context：滚动宿主与消息视图分处不同组件树深度，逐个
// prop 传递会迫使中间层全部重渲染。
// ─────────────────────────────────────────────────────────────────────────────

type ChatScrollActivityListener = (active: boolean) => void;

const listeners = new Set<ChatScrollActivityListener>();
let scrollActive = false;

/** 更新滚动活动状态；只有值变化时才广播。 */
export function setChatScrollActive(active: boolean): void {
  if (active === scrollActive) return;
  scrollActive = active;
  // 复制一份再遍历：订阅者在回调里退订 / 新订阅不影响本轮通知。
  for (const listener of [...listeners]) {
    try {
      listener(active);
    } catch {
      // 单个订阅者的异常不能中断其他消费者。
    }
  }
}

/** 订阅滚动活动变化；返回取消订阅函数（可重复调用）。 */
export function subscribeChatScrollActivity(listener: ChatScrollActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}