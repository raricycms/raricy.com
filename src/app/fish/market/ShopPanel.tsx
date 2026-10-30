'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from '@/app/components/Avatar';
import ChatBubble from '@/app/components/ChatBubble';
import type { BubbleKey } from '@/lib/bubble-refs';
import { fmtFish } from '@/lib/fish-amount';
import { frameUrl, type FrameKey } from '@/lib/frame-refs';
import { RENT_UNITS, parseRentCount, type RentUnit } from '@/lib/shop-refs';

// ─────────────────────────────────────────────────────────────────────────────
// ShopPanel —— 鱼干商城的租赁面板（/fish/shop）
//
// 【逐款一块表单】面板按 `items.map` 渲染，每款一张 `.market-card`（`data-frame=<key>`
// 与 `data-bubble=<key>` 是 e2e 的稳定钩子 —— 多款之后裸选择器会解析到多个元素，
// Playwright 的 strict 模式当场红）。**别改回 `items[0]`**：那会让其余在售款
// 从页面上消失，而服务端照样卖（过去有一条绊线用例专门盯这个，见
// tests/unit/frame-shop-guard.test.ts）。
//
// 【共享租期】鱼干蓝按天、星落月畔与两款直角气泡按月。单位、上下限、量词全从 `RENT_UNITS`
// 现读（零依赖的同一份表，服务端校验读的也是它）—— 面板**不自己判**哪款是按天的。
//
// 【它只画商品，判什么都在服务端】列表是 `/fish/shop` 的服务端组件调
// 两类商品的列表服务算好传进来的：哪款在卖、素材在不在、我当前持有到什么时候、
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
// 商城**内部**的余额是共享的：买完一款，另一款的可负担性立刻跟着变（见 onBalance）。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

/**
 * 两类商品共享租期、余额、持有结果。kind 决定白名单 key、预览和购买接口。
 * Date 已由服务端转成展示串，客户端不判断到期。
 */
export type ShopItemView = ({ kind: 'frame'; key: FrameKey } | { kind: 'bubble'; key: BubbleKey }) & {
  label: string;
  description: string;
  /** 计价单位 + 单价。上下限与量词在 `RENT_UNITS[unit]` 里，不随 DTO 来。 */
  rent: { unit: RentUnit; price: number };
  assetMissing: boolean;
  /** null = 从没持有过（或被收回）。 */
  holding: { expiresAt: string | null; expired: boolean } | null;
  equipped: boolean;
}

/** 各单位的快捷租期。**没有「全部」** —— 租期是用户自己决定的，不是余额决定的。 */
const QUICK_COUNTS: Record<RentUnit, readonly number[]> = {
  day: [1, 7, 30],
  month: [1, 3, 6, 12],
};

/**
 * 商城整体：持有**一份共享的余额**，逐款渲染一张卡。
 *
 * 余额之所以提在父层：买完任一框，另一张卡上的「租用后余额」与可负担性要立刻跟着变。
 * 各卡自己持一份的话，买完 A 再去点 B 会拿着一个过期的余额算账（服务端仍会挡住，
 * 但用户看到的数不对）。
 */
export default function ShopPanel({
  userId,
  balance: initialBalance,
  items,
  initialCategory = 'all',
}: {
  userId: string;
  balance: number;
  items: ShopItemView[];
  initialCategory?: 'all' | 'frame' | 'bubble';
}) {
  const [balance, setBalance] = useState(initialBalance);
  const [category, setCategory] = useState<'all' | 'frame' | 'bubble'>(initialCategory);

  if (items.length === 0) return null;

  return (
    <>
      <div className="market-shop__categories" role="group" aria-label="商品分类">
        {([['all', '全部'], ['frame', '头像框'], ['bubble', '聊天气泡']] as const).map(([kind, label]) => (
          <button type="button" key={kind} aria-pressed={category === kind}
            className={`market-shop__category${category === kind ? ' is-active' : ''}`}
            onClick={() => setCategory(kind)}>{label}</button>
        ))}
      </div>
      {items.filter((item) => category === 'all' || item.kind === category).map((item) => (
        <ShopItemCard
          key={`${item.kind}:${item.key}`}
          userId={userId}
          balance={balance}
          item={item}
          onBalance={setBalance}
        />
      ))}
    </>
  );
}

/** 一款商品一张卡：商品行 + 租期表单 + 二次确认弹窗。状态全是这一款自己的。 */
function ShopItemCard({
  userId,
  balance,
  item,
  onBalance,
}: {
  userId: string;
  balance: number;
  item: ShopItemView;
  onBalance: (balance: number) => void;
}) {
  const router = useRouter();
  const [count, setCount] = useState('1');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const unit = RENT_UNITS[item.rent.unit];
  const parsedCount = parseRentCount(item.rent.unit, count);
  const countOk = parsedCount !== null;
  const total = countOk ? item.rent.price * parsedCount : 0;
  const affordable = total <= balance;
  const permanent = !!item.holding && item.holding.expiresAt === null;
  const canSubmit = countOk && affordable && !item.assetMissing && !permanent;
  const afterBalance = affordable ? balance - total : balance;
  const previewUrl = item.kind === 'bubble' || item.assetMissing ? null : frameUrl(item.key);
  const bubble = item.kind === 'bubble';
  const itemSlug = bubble ? `bubble-${item.key}` : item.key;

  // id 逐款化：两款之后 `#market-shop-days` 这种单一 id 就不够用了（同一条理由
  // 让 `.market-shop__summary` 与 `.market-summary` 分了家，见 _fish-market.scss 尾部）。
  const inputId = `market-shop-count-${itemSlug}`;
  const confirmId = `market-shop-confirm-${itemSlug}`;

  // 表单底下那一行提示。**只有一条** —— 租期写错与钱不够不会同时说，
  // 两个 <p> 各挂一次同名类会让选择器有歧义（转账那条 `.market-summary` 就是这么翻的车）。
  // 区间与量词都从单位表来，别写死数字。
  const formError = permanent ? '你已永久持有，无需再租' : !countOk
    ? `租期填 ${unit.min}~${unit.max} ${unit.noun}之间的整数`
    : !affordable
      ? '小鱼干不足'
      : '';

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const res = await fetch(bubble ? '/api/fish/market/bubble-rent' : '/api/fish/market/rent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ [bubble ? 'bubble_key' : 'frame_key']: item.key, count: parsedCount }),
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
        if (typeof data.balance === 'number') onBalance(data.balance);
        setConfirmOpen(false);
        setCount('1');
        // 服务端渲染的「当前持有到 …」那一行要跟着变，否则买完看不出来生效了
        router.refresh();
      } else {
        // 失败保留弹窗与已填租期：429 这类瞬时故障原样再点一次就好
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
      <div className="market-card" data-frame={!bubble ? item.key : undefined} data-bubble={bubble ? item.key : undefined}>
        <div className="market-field">
          <span className="market-field__label">在售</span>
          <div className="market-shop__item">
            {bubble ? <ChatBubble bubbleKey={item.key}>你好，这是你的气泡预览。</ChatBubble> : <Avatar
              userId={userId}
              frameUrl={previewUrl}
              alt=""
              className="market-shop__preview"
              loading="lazy"
            />}
            <div className="market-shop__meta">
              <span className="market-shop__name">{item.label}</span>
              <span className="market-shop__desc">{item.description}</span>
              <span className="market-shop__price">
                <span className="numeric">{fmtFish(item.rent.price)}</span> {unit.priceNoun}
              </span>
            </div>
          </div>
          {item.holding && (
            <p className="market-field__hint market-shop__owned">
              {item.holding.expired ? '上次租的已过期' : '当前持有到'}
              <span className="numeric">{item.holding.expiresAt ? ` ${item.holding.expiresAt}` : ''}</span>
              {item.equipped && !item.holding.expired ? (bubble ? '（使用中）' : '（正戴着）') : ''}
            </p>
          )}
        </div>

        {item.assetMissing ? (
          <p className="market-shop__error">
            这款头像框的素材暂不可用，暂时无法购买。
          </p>
        ) : (
          <>
            <div className="market-field">
              <label className="market-field__label" htmlFor={inputId}>
                租多少{unit.noun}
              </label>
              <div className="market-amount">
                <input
                  id={inputId}
                  className="market-amount__input"
                  type="number"
                  inputMode="numeric"
                  min={unit.min}
                  max={unit.max}
                  step={1}
                  autoComplete="off"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  disabled={busy}
                />
                <span className="market-amount__unit">{unit.noun}</span>
              </div>
              <div className="market-quick">
                {QUICK_COUNTS[item.rent.unit].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="market-quick__btn"
                    onClick={() => setCount(String(d))}
                    disabled={busy}
                  >
                    <span className="numeric">{d}</span> {unit.noun}
                  </button>
                ))}
              </div>
            </div>

            <div className="market-shop__summary">
              <span>
                合计 <strong className="numeric">{fmtFish(total)}</strong> 鱼干
              </span>
              <span>
                租用后余额 <strong className="numeric">{fmtFish(afterBalance)}</strong> 鱼干
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
            {item.rent.unit === 'month' && <p className="market-field__hint numeric">1 个月按 {unit.days} 天计算。</p>}
            {item.holding && !item.holding.expired && <a className="frame-panel__hint-link" href={bubble ? '/settings#chat-bubble' : '/settings#avatar-frame'}>{bubble ? '选择聊天气泡' : '选择头像框'}</a>}
          </>
        )}
      </div>

      {confirmOpen && (
        <div className="modal-overlay show" onClick={() => !busy && setConfirmOpen(false)}>
          <div
            id={confirmId}
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
                  {bubble ? <ChatBubble bubbleKey={item.key}>你好，这是你的气泡预览。</ChatBubble> : <Avatar
                    userId={userId}
                    frameUrl={previewUrl}
                    alt=""
                    imgClassName="market-confirm__avatar"
                  />}
                  <span className="market-confirm__name">{item.label}</span>
                </div>
                <dl className="market-confirm__rows">
                  <div className="market-confirm__row">
                    <dt>租期</dt>
                    <dd>
                      <span className="numeric">{parsedCount}</span> {unit.noun}
                    </dd>
                  </div>
                  <div className="market-confirm__row">
                    <dt>单价</dt>
                    <dd>
                      <span className="numeric">{fmtFish(item.rent.price)}</span> {unit.priceNoun}
                    </dd>
                  </div>
                  <div className="market-confirm__row market-confirm__row--total">
                    <dt>合计</dt>
                    <dd className="numeric">{fmtFish(total)} 小鱼干</dd>
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
