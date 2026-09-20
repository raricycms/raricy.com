'use client';

import { useState } from 'react';
import Avatar from '@/app/components/Avatar';
import RecipientPicker, { type TransferTarget } from './RecipientPicker';

// 转账表单 + 二次确认弹窗。
//
// 【为什么要二次确认】转账没有撤回入口（钱是即时到账的），误点的代价是真金白银。
// 确认弹窗把「收款人 / 金额 / 留言 / 手续费 / 转账后余额」摆在一起让人复核一眼。
//
// 【重复提交 = 双倍转账】服务端每次提交都是独立的一笔新交易（幂等键带随机后缀），
// 所以 busy 期间按钮必须 disable 并锁死 —— 这是防重复提交的第一道闸
// （同 checkin 的翻牌按钮）。

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

/** 金额白名单：正整数或 1 位小数（与 fishToUnits 的口径一致，前端先挡一道）。 */
const AMOUNT_RE = /^\d+(\.\d)?$/;
const NOTE_MAX = 30;
/** 快捷加额 chips（**没有「全部」**：金额由用户自己决定）。 */
const QUICK = [1, 5, 10];

/** 鱼干展示：最多 1 位小数，去掉无意义的尾零（12 而不是 12.0）。 */
function fmtFish(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export default function TransferPanel({ balance: initialBalance }: { balance: number }) {
  const [balance, setBalance] = useState(initialBalance);
  const [recipient, setRecipient] = useState<TransferTarget | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const trimmed = amount.trim();
  const parsed = AMOUNT_RE.test(trimmed) ? Number(trimmed) : NaN;
  const amountError =
    trimmed === ''
      ? ''
      : !AMOUNT_RE.test(trimmed)
        ? '金额最多 1 位小数'
        : parsed <= 0
          ? '金额需大于 0'
          : parsed > balance
            ? '小鱼干不足'
            : '';
  const amountOk = Number.isFinite(parsed) && parsed > 0 && parsed <= balance;
  const canSubmit = recipient !== null && amountOk;
  const afterBalance = amountOk ? Math.round((balance - parsed) * 10) / 10 : balance;

  function addAmount(delta: number) {
    const cur = AMOUNT_RE.test(trimmed) ? Number(trimmed) : 0;
    setAmount(fmtFish(Math.round((cur + delta) * 10) / 10));
  }

  async function submit() {
    if (!recipient || !amountOk || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/market/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          to_user_id: recipient.id,
          amount: parsed,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        window.showToast?.(data.message ?? '转账成功', 'success');
        setBalance(typeof data.balance === 'number' ? data.balance : balance);
        setRecipient(null);
        setAmount('');
        setNote('');
        setConfirmOpen(false);
      } else {
        // 失败保留弹窗与已填内容：503 这类瞬时故障原样重试一次就好
        window.showToast?.(data?.message ?? '转账失败，请稍后再试', 'error');
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
        <div className="market-card__head">
          <span className="market-card__balance-label">我的余额</span>
          <span className="market-card__balance-number">{fmtFish(balance)}</span>
          <span className="market-card__balance-unit">小鱼干</span>
        </div>

        <div className="market-field">
          <span className="market-field__label">收款人</span>
          {recipient ? (
            <div className="market-recipient">
              <Avatar
                userId={recipient.id}
                frameUrl={recipient.frame_url}
                alt=""
                imgClassName="market-recipient__avatar"
              />
              <span className="market-recipient__name">{recipient.username}</span>
              <button
                type="button"
                className="market-recipient__change"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
              >
                更换
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="market-recipient-pick"
              onClick={() => setPickerOpen(true)}
              disabled={busy}
            >
              <span className="icon icon-person" aria-hidden="true"></span>选择收款人
            </button>
          )}
        </div>

        <div className="market-field">
          <label className="market-field__label" htmlFor="market-amount">
            转账金额
          </label>
          <div className="market-amount">
            <input
              id="market-amount"
              className="market-amount__input"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
            <span className="market-amount__unit">小鱼干</span>
          </div>
          <div className="market-quick">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                className="market-quick__btn"
                onClick={() => addAmount(q)}
                disabled={busy}
              >
                +{q}
              </button>
            ))}
          </div>
          {amountError && <p className="market-field__hint market-field__hint--error">{amountError}</p>}
        </div>

        <div className="market-field">
          <label className="market-field__label" htmlFor="market-note">
            留言（可选）
          </label>
          <input
            id="market-note"
            className="form-control market-note"
            type="text"
            maxLength={NOTE_MAX}
            placeholder="说点什么…"
            autoComplete="off"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <p className="market-field__hint">
            {note.length}/{NOTE_MAX}
          </p>
        </div>

        <div className="market-summary">
          <span>
            手续费 <strong className="market-summary__free">0</strong> 鱼干
          </span>
          <span>
            转账后余额 <strong>{fmtFish(afterBalance)}</strong> 鱼干
          </span>
        </div>

        <button
          type="button"
          className="market-submit"
          disabled={!canSubmit || busy}
          onClick={() => setConfirmOpen(true)}
        >
          转账
        </button>
      </div>

      {pickerOpen && (
        <RecipientPicker
          onPick={(u) => {
            setRecipient(u);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {confirmOpen && recipient && (
        <div className="modal-overlay show" onClick={() => !busy && setConfirmOpen(false)}>
          <div
            className="modal-dialog market-confirm"
            role="dialog"
            aria-label="确认转账"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">确认转账</h3>
              </div>
              <div className="modal-body">
                <div className="market-confirm__to">
                  <Avatar
                    userId={recipient.id}
                    frameUrl={recipient.frame_url}
                    alt=""
                    imgClassName="market-confirm__avatar"
                  />
                  <span className="market-confirm__name">{recipient.username}</span>
                </div>
                <dl className="market-confirm__rows">
                  <div className="market-confirm__row">
                    <dt>转账金额</dt>
                    <dd>{fmtFish(parsed)} 小鱼干</dd>
                  </div>
                  {note.trim() && (
                    <div className="market-confirm__row">
                      <dt>留言</dt>
                      <dd className="market-confirm__note">{note.trim()}</dd>
                    </div>
                  )}
                  <div className="market-confirm__row">
                    <dt>手续费</dt>
                    <dd className="market-confirm__free">0 小鱼干</dd>
                  </div>
                  <div className="market-confirm__row market-confirm__row--total">
                    <dt>转账后余额</dt>
                    <dd>{fmtFish(afterBalance)} 小鱼干</dd>
                  </div>
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
                    {busy ? '转账中…' : '确认转账'}
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
