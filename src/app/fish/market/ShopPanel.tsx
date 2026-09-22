'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from '@/app/components/Avatar';
import { fmtFish } from '@/lib/fish-amount';
import {
  FRAME_RENT_MAX_DAYS,
  FRAME_RENT_MIN_DAYS,
  frameUrl,
  parseRentDays,
  type FrameKey,
} from '@/lib/frame-refs';

// ─────────────────────────────────────────────────────────────────────────────
// ShopPanel —— 鱼干商城的租赁面板（/fish/market 的第二块，转账面板下面）
//
// 【它只画商品，判什么都在服务端】列表是 `/fish/market` 的服务端组件调
// `listShopItems()` 算好传进来的：哪款在卖、素材在不在、我当前持有到什么时候、
// 有没有过期 —— 全是**判定后的结果**。这里一次都不查时间（db-time-guard 规则 4–5
// 扫整个 src/，含页面组件），确认弹窗里也**不显示算出来的到期日期**：
// 真实到期时刻由服务端在响应里给，落进 toast。
//
// 【预览画的是「商品」，不是「我的框」】所以 frameUrl 从 `item.key` 拼 ——
// 用 `frameUrl()` 而不是手写模板串（那是 frame-refs 的出口，与头像 URL 同一条纪律）。
// 素材缺失时**不画预览**（画出来是一张裂图），只在服务端那侧它会 409 拒卖。
//
// 【重复提交 = 多买一笔】服务端不登记幂等（判据见 frame-shop-service 文件头：
// 每次点击都是一笔新交易），所以防连点只能靠这层：进确认弹窗要多点一下，
// 确认按钮 busy 期间锁死。两条都是**必要的**，别删掉其中一条「因为另一条够了」。
//
// 【已知缺口：余额与转账面板会短暂不一致】两个面板各持一份本地余额。
// 在这边买完框，上面的转账面板那个数还是旧的（它不重渲染）—— 那边真要转超了，
// 服务端会以「小鱼干不足」挡下，所以是**响亮**的失败、刷新即正，不是静默错账。
// 要根治得把余额提到共同的客户端状态里，那会动到转账面板，不在本次范围内。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

/**
 * 与 `frame-shop-service.ShopItem` 对应（那边的 Date 在这里已经是展示串）。
 *
 * ⚠️ `key` 是 `FrameKey` 而不是 `string` —— 商城在售的恒是白名单内的框，
 * 于是这里能直接 `frameUrl(key)` 拼预览地址（那个函数只收 FrameKey）。
 * 用 `import type` 拿类型：整条 import 会被擦掉，不会把拖着 prisma 的服务层
 * 带进客户端包。
 */
export interface ShopItemView {
  key: FrameKey;
  label: string;
  description: string;
  rentPerDay: number;
  assetMissing: boolean;
  /** null = 从没持有过（或被收回）。 */
  holding: { expiresAt: string | null; expired: boolean } | null;
  equipped: boolean;
}

/** 快捷天数。**没有「全部」** —— 天数是用户自己决定的，不是余额决定的。 */
const QUICK_DAYS = [1, 7, 30];

export default function ShopPanel({
  userId,
  balance: initialBalance,
  items,
}: {
  userId: string;
  balance: number;
  items: ShopItemView[];
}) {
  const router = useRouter();
  const [balance, setBalance] = useState(initialBalance);
  const [days, setDays] = useState('1');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 在售的只有一款（鱼干蓝）。**多款时要改成逐款一块表单** —— 这里先按
  // 「一次只租一款」写，别在没需求时为将来的样子预留结构。
  const item = items[0];
  if (!item) return null;

  const parsedDays = parseRentDays(days);
  const daysOk = parsedDays !== null;
  const cost = daysOk ? item.rentPerDay * parsedDays : 0;
  const affordable = cost <= balance;
  const canSubmit = daysOk && affordable && !item.assetMissing;
  const afterBalance = affordable ? balance - cost : balance;
  const previewUrl = item.assetMissing ? null : frameUrl(item.key);

  // 表单底下那一行提示。**只有一条** —— 天数写错与钱不够不会同时说，
  // 两个 <p> 各挂一次同名类会让选择器有歧义（转账那条 `.market-summary` 就是这么翻的车）。
  // 边界从常量来，别写死数字。
  const formError = !daysOk
    ? `天数填 ${FRAME_RENT_MIN_DAYS}~${FRAME_RENT_MAX_DAYS} 之间的整数`
    : !affordable
      ? '小鱼干不足'
      : '';

  async function submit() {
    if (!daysOk || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/market/rent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ frame_key: item.key, days: parsedDays }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        // **一条 toast，不是两条**：到期时刻由服务端算好给回来，拼在消息尾巴上。
        // 分成两条的话后者会盖住前者，用户只看得见最后一句（而那句里没有「租成功了」
        // 这个结论），e2e 也会取错元素。
        const msg = data.message ?? '租用成功';
        window.showToast?.(
          data.expires_at_text ? `${msg}（到期 ${data.expires_at_text}）` : msg,
          'success'
        );
        if (typeof data.balance === 'number') setBalance(data.balance);
        setConfirmOpen(false);
        setDays('1');
        // 服务端渲染的「当前持有到 …」那一行要跟着变，否则买完看不出来生效了
        router.refresh();
      } else {
        // 失败保留弹窗与已填天数：429 这类瞬时故障原样再点一次就好
        window.showToast?.(data?.message ?? '租用失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="market-card">
        <div className="market-field">
          <span className="market-field__label">在售</span>
          <div className="market-shop__item">
            <Avatar
              userId={userId}
              frameUrl={previewUrl}
              alt=""
              className="market-shop__preview"
              loading="lazy"
            />
            <div className="market-shop__meta">
              <span className="market-shop__name">{item.label}</span>
              <span className="market-shop__desc">{item.description}</span>
              <span className="market-shop__price">{fmtFish(item.rentPerDay)} 鱼干 / 天</span>
            </div>
          </div>
          {item.holding && (
            <p className="market-field__hint market-shop__owned">
              {item.holding.expired ? '上次租的已过期' : '当前持有到'}
              {item.holding.expiresAt ? ` ${item.holding.expiresAt}` : ''}
              {item.equipped && !item.holding.expired ? '（正戴着）' : ''}
            </p>
          )}
        </div>

        {item.assetMissing ? (
          <p className="market-shop__error">
            这款头像框的素材还没传上来，暂时买不了。站长补图后这里会自动放开。
          </p>
        ) : (
          <>
            <div className="market-field">
              <label className="market-field__label" htmlFor="market-shop-days">
                租多少天
              </label>
              <div className="market-amount">
                <input
                  id="market-shop-days"
                  className="market-amount__input"
                  type="number"
                  inputMode="numeric"
                  min={FRAME_RENT_MIN_DAYS}
                  max={FRAME_RENT_MAX_DAYS}
                  step={1}
                  autoComplete="off"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  disabled={busy}
                />
                <span className="market-amount__unit">天</span>
              </div>
              <div className="market-quick">
                {QUICK_DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="market-quick__btn"
                    onClick={() => setDays(String(d))}
                    disabled={busy}
                  >
                    {d} 天
                  </button>
                ))}
              </div>
            </div>

            <div className="market-shop__summary">
              <span>
                合计 <strong>{fmtFish(cost)}</strong> 鱼干
              </span>
              <span>
                租用后余额 <strong>{fmtFish(afterBalance)}</strong> 鱼干
              </span>
            </div>

            {formError && <p className="market-shop__error">{formError}</p>}

            <button
              type="button"
              className="market-shop__submit"
              disabled={!canSubmit || busy}
              onClick={() => setConfirmOpen(true)}
            >
              租用
            </button>
          </>
        )}
      </div>

      {confirmOpen && (
        <div className="modal-overlay show" onClick={() => !busy && setConfirmOpen(false)}>
          <div
            id="market-shop-confirm"
            className="modal-dialog market-confirm"
            role="dialog"
            aria-label="确认租用"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">确认租用</h3>
              </div>
              <div className="modal-body">
                <div className="market-confirm__to">
                  <Avatar
                    userId={userId}
                    frameUrl={previewUrl}
                    alt=""
                    imgClassName="market-confirm__avatar"
                  />
                  <span className="market-confirm__name">{item.label}</span>
                </div>
                <dl className="market-confirm__rows">
                  <div className="market-confirm__row">
                    <dt>租期</dt>
                    <dd>{parsedDays} 天</dd>
                  </div>
                  <div className="market-confirm__row">
                    <dt>单价</dt>
                    <dd>{fmtFish(item.rentPerDay)} 鱼干 / 天</dd>
                  </div>
                  <div className="market-confirm__row market-confirm__row--total">
                    <dt>合计</dt>
                    <dd>{fmtFish(cost)} 小鱼干</dd>
                  </div>
                  {/* ⚠️ 这一行**有意只写「接在现有到期之后」而不写日期**：到期时刻要么
                      从现有到期叠加、要么从现在起算，两者都得读库内那口钟，而客户端算出来
                      的一定是另一把钟上的值（差 8 小时，见 frame-refs.ts 头部）。
                      真实到期时刻由服务端在响应里给回来，落进 toast。 */}
                  {item.holding && !item.holding.expired && (
                    <div className="market-confirm__row">
                      <dt>租期起点</dt>
                      <dd>接在现有到期之后</dd>
                    </div>
                  )}
                </dl>
                <div className="market-confirm__actions">
                  <button
                    type="button"
                    className="market-confirm__cancel"
                    onClick={() => setConfirmOpen(false)}
                    disabled={busy}
                  >
                    再想想
                  </button>
                  <button
                    type="button"
                    className="market-confirm__ok"
                    onClick={() => void submit()}
                    disabled={busy}
                  >
                    {busy ? '租用中…' : '确认租用'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
