'use client';

import { useEffect, useState } from 'react';

/**
 * 是否运行在「已添加到主屏幕」的独立窗口里。
 *
 * 两条判据并集，任一成立即可：
 *   · display-mode media query（Android / 桌面 Chrome 等标准实现）；
 *   · iOS Safari 专有的 `navigator.standalone`（老版本 iOS 不认 media query）。
 *
 * 传 window 进来是为了**可单测**（不必起 jsdom）；判不出 / 抛异常一律当作「不是独立窗口」，
 * 即**照常显示引导** —— 宁可多显示一次，也不要让真的需要引导的人看不到。
 */
export function detectStandalone(win: {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: Navigator | { standalone?: boolean };
}): boolean {
  try {
    if (win.navigator && 'standalone' in win.navigator && win.navigator.standalone === true) return true;
    if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
  } catch {
    // 判不出就当不是独立窗口
  }
  return false;
}

/**
 * 设置页里的「添加到主屏幕」引导卡片。
 *
 * 刻意**不做任何自动安装 / 推送**：没有 beforeinstallprompt 拦截、没有横幅弹窗、
 * 也没有 UA 嗅探 —— 只给一段人话步骤，谁看都适用。行业里那些自动弹窗在 iOS 上本来
 * 也拦不到，只会变成噪音。
 *
 * 已经以独立窗口运行时整张卡片不渲染（判据见 detectStandalone）。SSR 阶段一律先按
 * 「非独立」渲染（此时读不到 window），挂载后 useEffect 再按真实情况收起 —— 这样
 * 禁用 JS 的读者也看得到引导，且不会与服务端首屏产生 hydration 冲突。
 */
export default function AddToHomeScreenGuide() {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const sync = () => setStandalone(detectStandalone(window));
    sync();
    // 极少数实现会在运行中切到独立模式，跟着更新一次。
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync);
      return () => mq.removeEventListener('change', sync);
    }
  }, []);

  if (standalone) return null;

  return (
    <div className="settings-card">
      <div className="settings-card__header">
        <span className="icon icon-box-arrow-right"></span>
        <h2 className="settings-card__title">添加到主屏幕</h2>
      </div>
      <p className="settings-card__desc">
        在 iPhone / iPad 的 Safari 里可以把聪明山装成一个独立的小应用，从主屏幕点开就像原生 App，
        不带浏览器的地址栏。
      </p>
      <ol>
        <li>用 Safari 打开本站。</li>
        <li>在 Safari 工具栏中选择「分享」（方框带向上箭头）；若未直接显示，先打开「更多」菜单。</li>
        <li>在弹出菜单里往下选「添加到主屏幕」。</li>
        <li>
          iOS 26 及以上：若出现「作为 Web App 打开」，保持开启，装好后以独立窗口打开；
          关掉就只是一个普通书签。
        </li>
        <li>确认名称后点「添加」。</li>
      </ol>
    </div>
  );
}
