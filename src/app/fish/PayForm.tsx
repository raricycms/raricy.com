'use client';

import { useState } from 'react';

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
// 【幂等键】键 = 「每次页面加载一个随机基」+ 金额：同键重试（超时后再点一次）服务端
// 认得出是同一笔，不会重复扣款；改了金额就是另一个意图、自动换新键。
// 见 docs/bot/fish-bot.md §6。
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

/** 最多 1 位小数的正数 —— 与 fish-units 的口径一致（前端先挡一道，服务端仍会复核）。 */
const AMOUNT_RE = /^\d+(\.\d)?$/;
/** 快捷金额（与鱼干市场转账页同一组）。 */
const QUICK = [1, 5, 10];
/** 备注长度上限 —— 与 fish-market-service 的 TRANSFER_NOTE_MAX 同值。
 *  （那边是服务端模块，客户端组件不能 import，故此处另立一份常量。） */
const NOTE_MAX = 30;

/** 鱼干展示：最多 1 位小数，去掉无意义的尾零。 */
function fmtFish(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** 金额校验：返回错误文案，空串表示通过。 */
function validateAmount(text: string, balance: number): string {
  if (!AMOUNT_RE.test(text)) return '金额最多 1 位小数';
  const n = Number(text);
  if (!(n > 0)) return '金额需大于 0';
  if (n > balance) return '小鱼干不足';
  return '';
}

/**
 * 幂等键 = 键基 + 金额。同一个金额重试是同一笔（服务端按账本行去重）；
 * 改了金额换新键 —— 否则服务端会按「同键不同参数」返回 409，把一次正常的新付款挡掉。
 */
function idempotencyKeyFor(keyBase: string, amount: number): string {
  return `${keyBase}-${amount}`;
}

export default function PayForm({
  variant,
  toId,
  toUsername,
  amount,
  note,
  merchant,
  returnUrl,
  balance,
}: {
  variant: PayFormVariant;
  toId: string;
  toUsername: string;
  /** cashier：商户定好的金额（只展示）；collect：忽略（金额由付款人自己填）。 */
  amount: number;
  /** cashier：商户写死的备注；collect：忽略（付款人可自己写）。 */
  note: string;
  merchant: string;
  returnUrl: string | null;
  balance: number;
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
  } | null>(null);
  // 每次页面加载一个键基；实际键 = 键基 + 金额（见文件头「幂等键」）。
  const [keyBase] = useState(() => {
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
  const afterBalance = Math.round((balance - effectiveAmount) * 10) / 10;
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
          idempotency_key: idempotencyKeyFor(keyBase, paid),
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setDone({
          balance: Number(data.balance) || 0,
          duplicated: !!data.duplicated,
          amount: paid,
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
          <img className="market-recipient__avatar" src={`/api/avatar/${toId}`} alt="" />
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
              className="form-control pay-amount__input"
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
          <div className="pay-quick">
            {QUICK.map((v) => (
              <button
                type="button"
                key={v}
                className="pay-quick__btn"
                onClick={() => setAmountText(String(v))}
                disabled={busy}
              >
                {v}
              </button>
            ))}
            <span className="pay-quick__hint">快捷金额</span>
          </div>
          {amountError && <p className="pay-amount__error">{amountError}</p>}
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
