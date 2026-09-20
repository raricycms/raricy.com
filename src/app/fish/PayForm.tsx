'use client';

import { useState } from 'react';
import Avatar from '@/app/components/Avatar';
import { AMOUNT_ERROR, fmtFish, parseFishAmount, roundFish } from '@/lib/fish-amount';

// ─────────────────────────────────────────────────────────────────────────────
// PayForm.tsx — 付款表单（收银台 /fish/pay 与扫码收款页 /fish/collect **共用**）
//
// 两个变体只差三处：金额是「别人定好的」还是「自己填的」、有没有商户横幅、
// 以及提交按钮与免责声明的措辞。**幂等键、step-up 密码、请求体、结果面板全部共用** ——
// 钱那条路径只能有一份实现，所以用 variant 分支，**不要为收款页另抄一个组件**。
//
// 调用方：
//   • /fish/pay     variant="cashier" —— 站外商户把用户送来付款（docs/bot/fish-bot.md §9）
//   • /fish/collect variant="collect" —— 扫别人的收款码付款（金额由付款人自己填）
//
// 【为什么这里要再输一次密码】站内自己转账只需点一下确认（人是自己点的、看得见上下文）；
// 而这一笔是**别人替你发起**的（商户拼的链接 / 扫到的收款码），多一道密码就多一道
// 「人真的在场且知情」。密码只提交给 raricy 自己的接口 —— 对方站点从始至终拿不到它。
//
// 【幂等键】两条路，由**商户有没有给订单号**决定（见 ../pay/page.tsx）：
//   · 给了 order → 键由「收款人 + 订单号」决定，**不拼金额**。同一次支付重试、乃至
//     付完刷新页面再点，服务端都认得出是同一笔；同单号换金额则响亮地 409。
//   · 没给 order（含扫码收款页全部）→ 随机基 + 金额。同一次加载内改金额自动换新键
//     （扫码页用户填错金额要能改了重提，不能被 409 挡掉），代价是**刷新即新键**：
//     付完刷新再付一次就是真的第二笔。给商户的链接拼上 order 即可得到前一种行为。
// 见 docs/bot/fish-bot.md §6 与 §9。
//
// ⚠️ cashier 分支的 DOM 类名与文案被 tests/e2e/fish-market.spec.ts 钉死了，改动它
// 之前先看那个用例。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

export type PayFormVariant = 'cashier' | 'collect';

/** 快捷金额（与鱼干市场转账页同一组）。 */
const QUICK = [1, 5, 10];
/** 备注长度上限 —— 与 fish-market-service 的 TRANSFER_NOTE_MAX 同值。
 *  （那边是服务端模块，客户端组件不能 import，故此处另立一份常量。） */
const NOTE_MAX = 30;

/** 金额校验：返回错误文案，空串表示通过。 */
function validateAmount(text: string, balance: number): string {
  if (parseFishAmount(text) === null) return AMOUNT_ERROR;
  // 位数上界：新键那一路要把金额拼进幂等键，而键有 48 字上限（见 idempotencyKeyFor）。
  // 不挡的话，一个 28 位以上的金额会让服务端回「幂等键格式不合法」—— 报的是内部实现。
  // 16 这个数留有余量：金额的整数部分最多 16 位，小数部分 4 位（FISH_DECIMALS）后
  // 仍是 21 字，离 48 字上限还远。
  if (text.length > 16) return '金额数字过长';
  const n = Number(text);
  if (!(n > 0)) return '金额需大于 0';
  if (n > balance) return '小鱼干不足';
  return '';
}

/**
 * 随机键基那一路的幂等键 = 键基 + 金额。同一个金额重试是同一笔（服务端按账本行去重）；
 * 改了金额换新键 —— 否则服务端会按「同键不同参数」返回 409，把一次正常的新付款挡掉。
 *
 * ⚠️ 这条只对**随机键基**成立。商户给了订单号时键由页面算好、**不拼金额**，
 * 理由见下面 randomKeyBase 附近的注释（两者的权衡正好相反）。
 */
function idempotencyKeyFor(keyBase: string, amount: number): string {
  return `${keyBase}-${amount}`;
}

export default function PayForm({
  variant,
  toId,
  toUsername,
  toFrameUrl,
  amount,
  note,
  merchant,
  returnUrl,
  balance,
  keyBase = null,
}: {
  variant: PayFormVariant;
  toId: string;
  toUsername: string;
  /**
   * 收款人的头像框贴图地址。**由服务端页面算好传进来** —— 本组件手里只有 `toId`
   *（来自 query），而判定到期要用 nowForDb()、还要查盘上素材，那些只能在服务端做。
   * 别在这里 fetch：那会多一次往返，而且客户端做时间比较会被 db-time-guard 判红。
   */
  toFrameUrl: string | null;
  /** cashier：商户定好的金额（只展示）；collect：忽略（金额由付款人自己填）。 */
  amount: number;
  /** cashier：商户写死的备注；collect：忽略（付款人可自己写）。 */
  note: string;
  merchant: string;
  returnUrl: string | null;
  balance: number;
  /**
   * 由**页面**算好的幂等键基（收银台在商户传了 `order` 时给出，见 ../pay/page.tsx）。
   * null = 没给订单号，退回下面 randomKeyBase 那一路。collect 永远为 null。
   *
   * 页面算而不是这里算：订单号的合法性、收款人哈希都属服务端的事，而且页面是
   * 服务器组件 —— 键一旦算出来就是可信输入，组件只负责原样送出去。
   */
  keyBase?: string | null;
}) {
  const isCollect = variant === 'collect';

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // collect 的金额与备注（cashier 走 props）
  const [amountText, setAmountText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [done, setDone] = useState<{
    balance: number;
    duplicated: boolean;
    amount: number;
    /** 共享单号（服务端按幂等键派生）。商户的流水里有同一个值，双方据此对账。 */
    transferId: string;
  } | null>(null);
  // 随机键基：每次页面加载换一个。**只在商户没给订单号时**才用它（collect 恒如此）。
  // 它换来的是「同一次加载内金额可变」——扫码收款页需要这个，用户填错金额改了再提交
  // 不该被服务端的「同键换参数」挡掉。代价是**刷新即新键**：付完刷新再付就是第二笔。
  const [randomKeyBase] = useState(() => {
    const rnd =
      typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
        ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        : Math.random().toString(36).slice(2, 18);
    return `pay-${rnd}`;
  });

  // collect：边输边校验（空串不算错，只是还没填）
  const amountError = isCollect && amountText ? validateAmount(amountText, balance) : '';
  const effectiveAmount = isCollect
    ? amountText && !amountError
      ? Number(amountText)
      : 0
    : amount;
  const afterBalance = roundFish(balance - effectiveAmount);
  const merchantHost = returnUrl ? new URL(returnUrl).host : '';
  const canSubmit = !busy && !!password && (!isCollect || (!!amountText && !amountError));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const paid = isCollect ? Number(amountText) : amount;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/market/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          to_user_id: toId,
          amount: paid,
          note: (isCollect ? noteText.trim() : note) || undefined,
          password,
          // 有订单号 → 页面算好的键，**不拼金额**（同单号换金额该在服务端 409，
          // 而不是静默变成第二笔扣款）。没订单号 → 随机键基 + 金额，见上。
          idempotency_key: keyBase ?? idempotencyKeyFor(randomKeyBase, paid),
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setDone({
          balance: Number(data.balance) || 0,
          duplicated: !!data.duplicated,
          amount: paid,
          transferId: typeof data.transfer_id === 'string' ? data.transfer_id : '',
        });
        setPassword('');
        window.showToast?.(data.message ?? '支付成功', 'success');
      } else {
        // 失败保留输入，用户改密码或稍后重试（同键重试是安全的）
        window.showToast?.(data?.message ?? '支付失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="market-card pay-result">
        <div className="pay-result__icon" aria-hidden="true">
          ✓
        </div>
        <p className="pay-result__title">
          {done.duplicated ? '这笔已经付过了' : isCollect ? '付款成功' : '支付成功'}
        </p>
        <p className="pay-result__amount">
          {fmtFish(done.amount)} <span>小鱼干</span>
        </p>
        <p className="pay-result__to">已付给 {toUsername}</p>
        <p className="pay-result__balance">当前余额 {fmtFish(done.balance)} 小鱼干</p>
        {done.transferId && (
          <p className="pay-result__receipt">
            凭据号 <code>{done.transferId}</code>
          </p>
        )}

        {returnUrl && (
          <a className="market-submit pay-result__return" href={returnUrl}>
            返回 {merchantHost}
          </a>
        )}
        <p className="pay-result__hint">
          {returnUrl
            ? '回到商户站点后，到账以本站账本为准（商户会自行核对，通常几秒内确认）。'
            : '可以在小鱼干流水里查看这笔支付。'}
        </p>
        <p className="market-foot">
          <a className="market-foot__link" href="/fish/transactions?type=transfer_all">
            查看转账记录
          </a>
        </p>
      </div>
    );
  }

  return (
    <form className="market-card" onSubmit={submit}>
      {!isCollect && (
        <div className="pay-merchant">
          <span className="pay-merchant__name">
            {merchant ? `来自 ${merchant} 的支付请求` : '来自站外商户的支付请求'}
          </span>
          {/* 商户名是链接里的自由文本，任何人都能拼成「聪明山官方」—— 必须明说 */}
          <span className="pay-merchant__badge">本站不验证商户身份</span>
        </div>
      )}

      <div className="market-field">
        <span className="market-field__label">收款人</span>
        <div className="market-recipient">
          <Avatar
            userId={toId}
            frameUrl={toFrameUrl}
            alt=""
            imgClassName="market-recipient__avatar"
          />
          <span className="market-recipient__name">{toUsername}</span>
        </div>
      </div>

      {isCollect ? (
        <div className="market-field">
          <label className="market-field__label" htmlFor="pay-amount">
            支付金额
          </label>
          <div className="market-amount pay-amount">
            <input
              id="pay-amount"
              className="form-control market-amount__input pay-amount__input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value.trim())}
              disabled={busy}
            />
            <span className="market-amount__unit">小鱼干</span>
          </div>
          <div className="market-quick pay-quick">
            {QUICK.map((v) => (
              <button
                type="button"
                key={v}
                className="market-quick__btn pay-quick__btn"
                onClick={() => setAmountText(String(v))}
                disabled={busy}
              >
                {v}
              </button>
            ))}
            <span className="pay-quick__hint">快捷金额</span>
          </div>
          {amountError && (
            <p className="market-field__hint market-field__hint--error pay-amount__error">
              {amountError}
            </p>
          )}
        </div>
      ) : (
        <div className="market-field">
          <span className="market-field__label">支付金额</span>
          <div className="market-amount pay-amount">
            <span className="pay-amount__value">{fmtFish(amount)}</span>
            <span className="market-amount__unit">小鱼干</span>
          </div>
        </div>
      )}

      {isCollect ? (
        <div className="market-field">
          <label className="market-field__label" htmlFor="pay-note">
            备注（可选）
          </label>
          <input
            id="pay-note"
            className="form-control"
            type="text"
            maxLength={NOTE_MAX}
            autoComplete="off"
            placeholder="给对方留一句话"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            disabled={busy}
          />
        </div>
      ) : (
        note && (
          <div className="market-field">
            <span className="market-field__label">备注</span>
            <p className="pay-note">{note}</p>
          </div>
        )
      )}

      <div className="market-field">
        <label className="market-field__label" htmlFor="pay-password">
          输入你的登录密码以确认
        </label>
        <input
          id="pay-password"
          className="form-control"
          type="password"
          autoComplete="current-password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      <div className="market-summary">
        <span>
          手续费 <strong className="market-summary__free">0</strong> 鱼干
        </span>
        <span>
          支付后余额 <strong>{fmtFish(afterBalance)}</strong> 鱼干
        </span>
      </div>

      <button type="submit" className="market-submit" disabled={!canSubmit}>
        {busy ? '支付中…' : isCollect ? '确认付款' : '确认支付'}
      </button>
      <p className="pay-disclaimer">
        {isCollect
          ? '付款即时到账、不可撤回。确认前请核对上方收款人 —— 二维码是谁都能转发的，只有这里显示的收款人才算数。'
          : '支付即时到账、不可撤回。确认前请核对上方收款人与金额 —— 本站不对站外商户的行为负责。'}
      </p>
    </form>
  );
}
