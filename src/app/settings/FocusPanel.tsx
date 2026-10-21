'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FocusPanel.tsx — 设置页「专注模式」卡片（总开关 + 三类干扰源 + 博客栏目自选）
//
// 【数据源】GET/PATCH /api/users/me/focus（见 src/app/api/users/me/focus/route.ts）。
// 不塞进 GET /api/users/me：那份是「本人资料」，而这里要的是「状态 + 可选项清单」。
//
// 【两种「未选择」不可合并】
//   customized=false → 沿用站长标记的 categories.focusHidden 默认集合；
//   customized=true  → selected 就是用户的选择（可能是空数组 = 一个都不屏蔽）。
// 「恢复默认」发 hiddenCategoryIds: null；取消所有勾选发 [] —— 二者的落库形态不同。
//
// 【勾根栏目 = 连同子栏目一起屏蔽】服务端已把 selected 展开成「自己 + 子栏目」，
// 所以这里勾根时把子项 id 一起加进集合、取消时一起删掉。界面上子项也会跟着显示
// 为已勾选 —— 否则「勾了根、子项却是空框」看上去像没生效。
//
// 【保存失败要回滚界面】所有保存都是乐观更新 + 失败回滚。只弹错不回滚的话，
// 页面会停在一个「看起来已保存」的假状态，下一次刷新又变回去 —— 静默失效。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  FocusCategoryOption,
  FocusSettingsValues,
  FocusStatePayload,
} from '@/lib/focus-mode';

type AlertKind = 'success' | 'danger';

interface Props {
  /** 复用页面已有的 #focusAlert 提示条（e2e 与既有交互都认这个 id）。 */
  onAlert: (kind: AlertKind, msg: string) => void;
}

const SAVED_MSG = '专注模式设置已保存';

export default function FocusPanel({ onAlert }: Props) {
  const router = useRouter();
  const [state, setState] = useState<FocusStatePayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/users/me/focus', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const data = await res.json();
        if (!alive) return;
        if (data.code === 200 && data.settings) setState(data as FocusStatePayload);
      } catch {
        // 加载失败：保持「加载中…」，用户刷新页面即可重试（不谎报「没有屏蔽任何东西」）
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 发一次 PATCH；成功时用服务端回的新状态整份替换本地状态。 */
  async function save(body: Record<string, unknown>, successMsg = SAVED_MSG): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch('/api/users/me/focus', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.code === 200 && data.settings) {
        setState(data as FocusStatePayload);
        onAlert('success', successMsg);
        // 服务端页面（/blog、/game、/fish、/chat）按新值渲染；软导航不会重跑 root layout。
        router.refresh();
        return true;
      }
      onAlert('danger', data.message || '保存失败');
    } catch {
      onAlert('danger', '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
    return false;
  }

  /** 总开关 / 三个子项：乐观更新，失败回滚。 */
  async function updateSettings(patch: Partial<FocusSettingsValues>) {
    if (!state) return;
    const prev = state;
    setState({ ...prev, settings: { ...prev.settings, ...patch } });
    if (!(await save(patch))) setState(prev);
  }

  /** 栏目选择：勾选集合整份回传（服务端会再展开一次子树，幂等）。 */
  async function saveSelection(next: number[]) {
    if (!state) return;
    const prev = state;
    setState({ ...prev, selected: next, customized: true });
    if (!(await save({ hiddenCategoryIds: next }))) setState(prev);
  }

  function childIds(categories: FocusCategoryOption[], rootId: number): number[] {
    return categories.filter((c) => c.parentId === rootId).map((c) => c.id);
  }

  function toggleRoot(root: FocusCategoryOption, checked: boolean) {
    if (!state) return;
    const ids = [root.id, ...childIds(state.categories, root.id)];
    const next = new Set(state.selected);
    for (const id of ids) checked ? next.add(id) : next.delete(id);
    void saveSelection([...next]);
  }

  function toggleChild(child: FocusCategoryOption, checked: boolean) {
    if (!state) return;
    const next = new Set(state.selected);
    checked ? next.add(child.id) : next.delete(child.id);
    void saveSelection([...next]);
  }

  if (!state) {
    return <p className="settings-card__desc">加载中…</p>;
  }

  const { settings, categories, selected, customized } = state;
  const selectedSet = new Set(selected);
  const byId = new Map(categories.map((c) => [c.id, c]));
  // 父栏目不在清单里（父栏目被删/自身停用未选中）的子项按根渲染，否则会整行消失。
  const roots = categories.filter((c) => c.parentId == null || !byId.has(c.parentId));
  const childrenOf = new Map<number, FocusCategoryOption[]>();
  for (const c of categories) {
    if (c.parentId != null && byId.has(c.parentId)) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c);
      childrenOf.set(c.parentId, list);
    }
  }

  const toggles: { key: keyof FocusSettingsValues & ('blockLobby' | 'blockGames' | 'blockFishTrade'); id: string; title: string; desc: string }[] = [
    {
      key: 'blockLobby',
      id: 'toggleFocusLobby',
      title: '屏蔽讨论大区',
      desc: '只影响讨论大区；私聊照常',
    },
    {
      key: 'blockGames',
      id: 'toggleFocusGames',
      title: '屏蔽玩具区',
      desc: '顶栏与首页的玩具入口一并隐藏',
    },
    {
      key: 'blockFishTrade',
      id: 'toggleFocusFishTrade',
      title: '屏蔽鱼干练手盘',
      desc: '含统计页；鱼干商城与转账不受影响',
    },
  ];

  function categoryRow(c: FocusCategoryOption, child: boolean) {
    return (
      <label className={`focus-cats__item${child ? ' focus-cats__item--child' : ''}`}>
        <input
          type="checkbox"
          className="focus-cats__check"
          data-focus-category={c.id}
          checked={selectedSet.has(c.id)}
          disabled={busy}
          onChange={(e) => (child ? toggleChild(c, e.target.checked) : toggleRoot(c, e.target.checked))}
        />
        <span className="focus-cats__name">{c.name}</span>
        {!c.isActive && <span className="focus-cats__tag">已停用</span>}
        {!customized && c.focusHidden && <span className="focus-cats__tag">默认</span>}
      </label>
    );
  }

  return (
    <>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row__label">
          <span className="settings-toggle-row__title">专注模式</span>
          <span className="settings-toggle-row__desc">按下面的范围屏蔽干扰源，可随时关闭</span>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            id="toggleFocus"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => updateSettings({ enabled: e.target.checked })}
          />
          <span className="settings-toggle__slider"></span>
        </label>
      </div>

      {toggles.map((t) => (
        <div className="settings-toggle-row" key={t.key}>
          <div className="settings-toggle-row__label">
            <span className="settings-toggle-row__title">{t.title}</span>
            <span className="settings-toggle-row__desc">
              {t.desc}
              {!settings.enabled && '（总开关关闭时不生效）'}
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              id={t.id}
              checked={settings[t.key]}
              disabled={busy}
              onChange={(e) => updateSettings({ [t.key]: e.target.checked })}
            />
            <span className="settings-toggle__slider"></span>
          </label>
        </div>
      ))}

      <div className="focus-cats">
        <div className="focus-cats__head">
          <span className="settings-toggle-row__title">屏蔽的博客栏目</span>
          <p className="focus-cats__hint">
            {customized
              ? '已按你的选择屏蔽；勾选一个板块会连同其子板块一起屏蔽。'
              : '默认屏蔽站长标记的「专注隐藏」栏目；勾选一个板块会连同其子板块一起屏蔽。'}
          </p>
        </div>

        {categories.length === 0 ? (
          <p className="focus-cats__hint">暂无可选栏目。</p>
        ) : (
          <ul className="focus-cats__list">
            {roots.map((root) => {
              const children = childrenOf.get(root.id) ?? [];
              return (
                <li className="focus-cats__group" key={root.id}>
                  {categoryRow(root, false)}
                  {children.length > 0 && (
                    <ul className="focus-cats__children">
                      {children.map((child) => (
                        <li key={child.id}>{categoryRow(child, true)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="focus-cats__actions">
          {customized && (
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={() => void save({ hiddenCategoryIds: null }, '已恢复默认屏蔽范围')}
            >
              恢复默认
            </button>
          )}
          <span className="focus-cats__hint">未自定义时使用站长标记的栏目。</span>
        </div>
      </div>
    </>
  );
}
