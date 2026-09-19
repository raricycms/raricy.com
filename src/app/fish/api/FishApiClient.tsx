'use client';

import { useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// FishApiClient.tsx — /fish/api 的交互部分（只读凭据的签发 / 吊销）
//
// 为什么是客户端组件：签发后要**当场显示一次性明文**、吊销后要就地刷新列表 ——
// 这两件事都发生在用户还停在页面上时。初始列表由服务器组件传进来（首屏不需要等 JS）。
//
// 【明文只显示一次】服务端签发后立刻把明文回给我们，此后库里只有 sha256、取不回来。
// 所以这一段 UI 的职责是**让它难以被忽略**：醒目的底 + 「只显示这一次」+ 复制按钮，
// 且用户点了「我已保存」之前不清掉。别做成 toast —— toast 几秒就没，而没抄走的
// 凭据是永久丢失的（只能吊销重签）。
//
// 【吊销不要二次确认弹窗】吊销是安全方向的动 作（fail-safe），而重新签发只是一次
// 点击。给它加确认框是在用户最想立刻止损的时刻多拦一道。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

export interface TokenRow {
  id: number;
  label: string | null;
  scopes: string;
  created_at: string | null;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expired: boolean;
}

/** 时间戳是本站时钟（UTC+8 墙上时间贴 Z）—— 一律 getUTC* 读，本地 getter 会整体平移。 */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function statusOf(t: TokenRow): { text: string; kind: 'ok' | 'off' } {
  if (t.revoked_at) return { text: '已吊销', kind: 'off' };
  if (t.expired) return { text: '已过期', kind: 'off' };
  return { text: '有效', kind: 'ok' };
}

export default function FishApiClient({ initialTokens }: { initialTokens: TokenRow[] }) {
  const [tokens, setTokens] = useState<TokenRow[]>(initialTokens);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // 一次性明文。非 null 时那一整块面板压在最上面，直到用户确认已保存。
  const [secret, setSecret] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch('/api/fish/tokens', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (Array.isArray(data?.tokens)) setTokens(data.tokens as TokenRow[]);
  }

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ label: label.trim() || undefined, password }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setSecret(String(data.secret));
        setLabel('');
        setPassword('');
        await refresh();
      } else {
        // 失败保留输入：多半只是密码打错了，重打一次即可
        window.showToast?.(data?.message ?? '签发失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/fish/tokens/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        window.showToast?.('凭据已吊销，立即失效', 'success');
        await refresh();
      } else {
        window.showToast?.(data?.message ?? '吊销失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      window.showToast?.('已复制到剪贴板', 'success');
    } catch {
      window.showToast?.('复制失败，请手动选中复制', 'error');
    }
  }

  return (
    <>
      {secret && (
        <div className="fish-api-secret">
          <p className="fish-api-secret__warn">⚠️ 只显示这一次 —— 离开本页后无法再取回</p>
          <code className="fish-api-secret__value">{secret}</code>
          <div className="fish-api-secret__actions">
            <button type="button" className="fish-api-copy" onClick={copySecret}>
              复制
            </button>
            <button
              type="button"
              className="fish-api-secret__dismiss"
              onClick={() => setSecret(null)}
            >
              我已保存
            </button>
          </div>
        </div>
      )}

      <form className="market-card" onSubmit={mint}>
        <div className="market-field">
          <label className="market-field__label" htmlFor="token-label">
            凭据备注（可选）
          </label>
          <input
            id="token-label"
            className="form-control"
            type="text"
            maxLength={30}
            autoComplete="off"
            placeholder="例如：对账机器人"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="market-field">
          <label className="market-field__label" htmlFor="token-password">
            输入你的登录密码以确认
          </label>
          <input
            id="token-password"
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

        <button type="submit" className="market-submit" disabled={busy || !password}>
          {busy ? '处理中…' : '签发只读凭据'}
        </button>
        <p className="pay-disclaimer">
          凭据只能<strong>查</strong>余额与流水，不能转账，也不能提现。改密码不会作废它 ——
          要停用请在这里吊销（立即生效）。
        </p>
      </form>

      {tokens.length === 0 ? (
        <p className="fish-api-empty">还没有签发过凭据。</p>
      ) : (
        <div className="fish-api-list">
          {tokens.map((t) => {
            const st = statusOf(t);
            return (
              <div className="fish-api-row" key={t.id}>
                <div className="fish-api-row__main">
                  <div className="fish-api-row__head">
                    <span className="fish-api-row__label">{t.label ?? `凭据 #${t.id}`}</span>
                    <span
                      className={`fish-api-badge${st.kind === 'ok' ? ' fish-api-badge--ok' : ' fish-api-badge--off'}`}
                    >
                      {st.text}
                    </span>
                  </div>
                  <p className="fish-api-row__meta">
                    权限 {t.scopes} · 签发于 {fmtDate(t.created_at)} · 到期{' '}
                    {fmtDate(t.expires_at)} · 最后使用 {fmtDate(t.last_used_at)}
                  </p>
                </div>
                <div className="fish-api-row__actions">
                  {/* 已吊销的不给按钮 —— 再点一次是空操作，留着只会让人以为还能做点什么 */}
                  {!t.revoked_at && (
                    <button
                      type="button"
                      className="fish-api-revoke"
                      onClick={() => revoke(t.id)}
                      disabled={busy}
                    >
                      吊销
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
