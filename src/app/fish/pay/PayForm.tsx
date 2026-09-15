'use client';

import { useState } from 'react';

// 收银台表单：确认金额 → **再输一次本人密码**（step-up）→ 支付 → 结果面板。
//
// 【为什么这里要再输一次密码】站内自己转账只需点一下确认（人是自己点的、看得见上下文）；
// 而这一笔是**别人替你发起**的（商户拼的链接），多一道密码就多一道「人真的在场且知情」。
// 密码只提交给 raricy 自己的接口 —— 商户站点从始至终拿不到它（见 page.tsx 的注释）。
//
// 【幂等键】本页加载时生成一次、每次提交都带上：超时/网络抖动后用户再点一次
// 「确认支付」时，服务端认得出是同一笔，不会重复扣款（见 docs/fish-bot.md §6）。

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

/** 鱼干展示：最多 1 位小数，去掉无意义的尾零。 */
function fmtFish(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export default function PayForm({
  toId,
  toUsername,
  amount,
  note,
  merchant,
  returnUrl,
  balance,
}: {
  toId: string;
  toUsername: string;
  amount: number;
  note: string;
  merchant: string;
  returnUrl: string | null;
  balance: number;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ balance: number; duplicated: boolean } | null>(null);
  // 每张收银台页面一个键：用户重试（超时后再点一次）也还是同一笔。
  const [idempotencyKey] = useState(() => {
    const rnd =
      typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
        ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        : Math.random().toString(36).slice(2, 18);
    return `pay-${rnd}`;
  });

  const afterBalance = Math.round((balance - amount) * 10) / 10;
  const merchantHost = returnUrl ? new URL(returnUrl).host : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/market/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          to_user_id: toId,
          amount,
          note: note || undefined,
          password,
          idempotency_key: idempotencyKey,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setDone({ balance: Number(data.balance) || 0, duplicated: !!data.duplicated });
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
          {done.duplicated ? '这笔已经付过了' : '支付成功'}
        </p>
        <p className="pay-result__amount">
          {fmtFish(amount)} <span>小鱼干</span>
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
      <div className="pay-merchant">
        <span className="pay-merchant__name">
          {merchant ? `来自 ${merchant} 的支付请求` : '来自站外商户的支付请求'}
        </span>
        {/* 商户名是链接里的自由文本，任何人都能拼成「聪明山官方」—— 必须明说 */}
        <span className="pay-merchant__badge">本站不验证商户身份</span>
      </div>

      <div className="market-field">
        <span className="market-field__label">收款人</span>
        <div className="market-recipient">
          <img className="market-recipient__avatar" src={`/api/avatar/${toId}`} alt="" />
          <span className="market-recipient__name">{toUsername}</span>
        </div>
      </div>

      <div className="market-field">
        <span className="market-field__label">支付金额</span>
        <div className="market-amount pay-amount">
          <span className="pay-amount__value">{fmtFish(amount)}</span>
          <span className="market-amount__unit">小鱼干</span>
        </div>
      </div>

      {note && (
        <div className="market-field">
          <span className="market-field__label">备注</span>
          <p className="pay-note">{note}</p>
        </div>
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

      <button type="submit" className="market-submit" disabled={!password || busy}>
        {busy ? '支付中…' : '确认支付'}
      </button>
      <p className="pay-disclaimer">
        支付即时到账、不可撤回。确认前请核对上方收款人与金额 —— 本站不对站外商户的行为负责。
      </p>
    </form>
  );
}
