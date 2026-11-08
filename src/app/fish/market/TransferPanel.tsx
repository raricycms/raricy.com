'use client';

import { useRef, useState } from 'react';
import Avatar from '@/app/components/Avatar';
import {
  AMOUNT_ERROR,
  fmtFish,
  fmtFishInput,
  parseFishAmount,
  roundFish,
} from '@/lib/fish-amount';
import RecipientPicker, { type TransferTarget } from './RecipientPicker';

// 转账表单 + 二次确认弹窗。
//
// 【为什么要二次确认】转账没有撤回入口（钱是即时到账的），误点的代价是真金白银。
// 确认弹窗把「收款人 / 金额 / 留言 / 手续费 / 转账后余额」摆在一起让人复核一眼。
//
// 【重复提交 = 双倍转账】busy 期间按钮 disable 是第一道闸（防连点）。但「响应丢了」
// 的那一次提交可能已经在服务端成交 —— 所以每次确认还带一个**一次性幂等键**（见
// idemRef）：同一个键 + 同样的参数重试，服务端回报原单而不是再转一笔。键的生命周期
// 比按钮锁更细，规则写在 idemRef 的定义处。
//
// 同款模式：收银台 PayForm.randomKeyBase（商户没给订单号时）、练手盘 TradePanel.openBuy。

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

const NOTE_MAX = 30;
/** 快捷加额 chips（**没有「全部」**：金额由用户自己决定）。 */
const QUICK = [1, 5, 10];

/**
 * 网页转账的一次性幂等键。`web-` 是来源前缀（运维查表时与 bot 的 `wd-…` 区分开），
 * 后 16 位随机 —— 生成方式照 `PayForm.randomKeyBase`（randomUUID 去横线截断）。
 *
 * 长度 20 ≤ 48、字符集满足服务端 `CLIENT_KEY_RE`（1-48 位 `A-Za-z0-9_.:-`）。
 * 服务端会再派生成 `xfer-{sha256(发起人)[:16]}-{这个键}` 落进账本（R3-314 起 16 位；
 * 旧 8 位键仍由读路径双读，不产生新键）。
 */
function newTransferKey(): string {
  const rnd =
    typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `web-${rnd}`;
}

export default function TransferPanel({ balance: initialBalance }: { balance: number }) {
  const [balance, setBalance] = useState(initialBalance);
  const [recipient, setRecipient] = useState<TransferTarget | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── 幂等键：这一笔转账在服务端的身份 ────────────────────────────────────────
  //
  // 生命周期（每一条都对应一种「静默多扣一笔」的错法）：
  //   · 打开确认弹窗时**仅在还没有键时**生成。取消后重开、参数没变 → **必须复用
  //     同一个键**：响应丢失时用户很可能点「再想想」再重开一次，这里若每次重开都
  //     换键，「重试」就真成了第二笔转账。
  //   · 收款人 / 金额 / 留言一变就作废：服务端对「同键换参数」回 409，改参数是
  //     用户要发起另一笔，必须换新键（下次确认/提交时生成）。
  //   · **成功后才清键**：接着要转的下一笔是新交易，必须换新键；失败（含网络错误、
  //     500）保留，原样重试才是安全的。
  //   · 提交时若键为空（参数在提交前变过）再兜底生成 —— 网页这条路永远带键，
  //     服务端对无键请求按「重试 = 再转一笔」处理。
  const idemRef = useRef<string>('');

  /** 打开确认弹窗前调用：没有键就为「这一笔」生成一个。 */
  function ensureTransferKey() {
    if (!idemRef.current) idemRef.current = newTransferKey();
  }

  /** 参数变了：当前键作废，下一次确认/提交会生成新键（同键异参服务端会 409）。 */
  function invalidateTransferKey() {
    idemRef.current = '';
  }

  const trimmed = amount.trim();
  const parsed = parseFishAmount(trimmed) ?? NaN;
  const amountError =
    trimmed === ''
      ? ''
      : !Number.isFinite(parsed)
        ? AMOUNT_ERROR
        : parsed <= 0
          ? '金额需大于 0'
          : parsed > balance
            ? '小鱼干不足'
            : '';
  const amountOk = Number.isFinite(parsed) && parsed > 0 && parsed <= balance;
  const canSubmit = recipient !== null && amountOk;
  const afterBalance = amountOk ? roundFish(balance - parsed) : balance;

  function addAmount(delta: number) {
    const cur = parseFishAmount(trimmed) ?? 0;
    invalidateTransferKey();
    setAmount(fmtFishInput(cur + delta));
  }

  async function submit() {
    if (!recipient || !amountOk || busy) return;
    // 兜底：正常路径已由 ensureTransferKey 生成；参数在提交前变过时这里补一个。
    if (!idemRef.current) idemRef.current = newTransferKey();
    const idempotencyKey = idemRef.current;
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
          // 同一个键 + 同样的收款人/金额/留言 = 同一笔：超时/响应丢失后重试安全。
          // 服务端据此登记账本行，重放时回报原单而不是再转一笔（docs/bot/fish-bot.md §6.1）。
          idempotency_key: idempotencyKey,
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
        // 成功才清：这一笔已经结束，下一笔必须换新键。
        idemRef.current = '';
      } else {
        // 失败保留弹窗与已填内容：503 这类瞬时故障原样重试一次就好（同键重试是安全的）
        window.showToast?.(data?.message ?? '转账失败，请稍后再试', 'error');
      }
    } catch {
      // 响应可能已经在服务端落地（弱网 / 反代超时）：保留键，用户再点确认就是重放而非第二笔。
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
          <span className="market-card__balance-value">
            <span className="market-card__balance-number numeric">{fmtFish(balance)}</span>
            <span className="market-card__balance-unit">小鱼干</span>
          </span>
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
              onChange={(e) => {
                invalidateTransferKey();
                setAmount(e.target.value);
              }}
              disabled={busy}
            />
            <span className="market-amount__unit">小鱼干</span>
          </div>
          <div className="market-quick">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                className="market-quick__btn numeric"
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
            onChange={(e) => {
              invalidateTransferKey();
              setNote(e.target.value);
            }}
            disabled={busy}
          />
          <p className="market-field__hint numeric">
            {note.length}/{NOTE_MAX}
          </p>
        </div>

        <div className="market-summary">
          <span>
            手续费 <strong className="market-summary__free">0</strong> 鱼干
          </span>
          <span>
            转账后余额 <strong className="numeric">{fmtFish(afterBalance)}</strong> 鱼干
          </span>
        </div>

        <button
          type="button"
          className="market-submit"
          disabled={!canSubmit || busy}
          onClick={() => {
            ensureTransferKey();
            setConfirmOpen(true);
          }}
        >
          转账
        </button>
      </div>

      {pickerOpen && (
        <RecipientPicker
          onPick={(u) => {
            invalidateTransferKey();
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
                    <dd className="numeric">{fmtFish(parsed)} 小鱼干</dd>
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
                    <dd className="numeric">{fmtFish(afterBalance)} 小鱼干</dd>
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
