'use client';

import { useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// FishWebhookPanel.tsx — /fish/api 的回调配置区
//
// 与 FishApiClient 分开两个文件：那边是「凭据」，这边是「回调」，两者的状态彼此
// 独立（签一张凭据不该让回调那一块重渲染）。页面把两边并排放。
//
// 【一次性明文同样是重点】签名密钥只在登记 / 换密钥那一次返回，之后库里只有密文
//（**是密文不是哈希** —— 我们还得用它去签名，所以能解密回来；但界面不给二次读取，
//  免得它变成一个「随时可看」的长期秘密）。
//
// 【停用不给二次确认】同凭据那一侧：停用是安全方向的动作，且随时可以重新登记。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

export interface WebhookEndpointView {
  url: string;
  disabled: boolean;
  disabled_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string | null;
}

export interface DeliveryRow {
  id: number;
  delivery_id: string;
  transfer_id: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  last_status_code: number | null;
  delivered_at: string | null;
  created_at: string | null;
}

/** 时间戳是本站时钟（UTC+8 墙上时间贴 Z）—— 一律 getUTC* 读。 */
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待投递',
  sending: '投递中',
  delivered: '已送达',
  dead: '已判死',
};

export default function FishWebhookPanel({
  initialEndpoint,
  initialDeliveries,
}: {
  initialEndpoint: WebhookEndpointView | null;
  initialDeliveries: DeliveryRow[];
}) {
  const [endpoint, setEndpoint] = useState<WebhookEndpointView | null>(initialEndpoint);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>(initialDeliveries);
  const [url, setUrl] = useState(initialEndpoint?.url ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch('/api/fish/webhook', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.code === 200) {
      setEndpoint(data.endpoint as WebhookEndpointView | null);
      setDeliveries((data.deliveries ?? []) as DeliveryRow[]);
      if (data.endpoint?.url) setUrl(data.endpoint.url as string);
    }
  }

  async function call(
    path: string,
    init: RequestInit,
    okMessage: string
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    try {
      const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        window.showToast?.(data.message ?? okMessage, 'success');
        return data as Record<string, unknown>;
      }
      window.showToast?.(data?.message ?? '操作失败，请稍后再试', 'error');
      return null;
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !url.trim() || !password) return;
    const data = await call(
      '/api/fish/webhook',
      { method: 'PUT', body: JSON.stringify({ url: url.trim(), password }) },
      '已保存'
    );
    if (data) {
      setPassword('');
      if (typeof data.secret === 'string') setSecret(data.secret);
      await refresh();
    }
  }

  async function rotate() {
    if (busy || !password) {
      window.showToast?.('请先在下面填入密码', 'error');
      return;
    }
    const data = await call(
      '/api/fish/webhook/rotate',
      { method: 'POST', body: JSON.stringify({ password }) },
      '已更换'
    );
    if (data && typeof data.secret === 'string') {
      setSecret(data.secret);
      setPassword('');
    }
  }

  async function disable() {
    const data = await call('/api/fish/webhook', { method: 'DELETE' }, '已停用');
    if (data) await refresh();
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
          <p className="fish-api-secret__warn">
            ⚠️ 签名密钥只显示这一次 —— 用它校验我们发来的回调（算法见文档）
          </p>
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

      <form className="market-card" onSubmit={save}>
        <div className="market-field">
          <label className="market-field__label" htmlFor="webhook-url">
            回调地址
          </label>
          <input
            id="webhook-url"
            className="form-control"
            type="url"
            autoComplete="off"
            placeholder="https://你的站点/fish/callback"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          <p className="market-field__hint">
            必须 https、直接返回 2xx（我们不跟随重定向），且不能指向内网地址。
          </p>
        </div>

        <div className="market-field">
          <label className="market-field__label" htmlFor="webhook-password">
            输入你的登录密码以确认
          </label>
          <input
            id="webhook-password"
            className="form-control"
            type="password"
            autoComplete="current-password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>

        <button type="submit" className="market-submit" disabled={busy || !url.trim() || !password}>
          {busy ? '处理中…' : endpoint ? '更新回调地址' : '登记回调地址'}
        </button>
      </form>

      {endpoint && (
        <>
          <div className="fish-api-list">
            <div className="fish-api-row">
              <div className="fish-api-row__main">
                <div className="fish-api-row__head">
                  <span className="fish-api-row__label">{endpoint.url}</span>
                  <span
                    className={`fish-api-badge${endpoint.disabled ? ' fish-api-badge--off' : ' fish-api-badge--ok'}`}
                  >
                    {endpoint.disabled ? '已停用' : '启用中'}
                  </span>
                </div>
                <p className="fish-api-row__meta">
                  连续失败 {endpoint.consecutive_failures} 次 · 最近成功{' '}
                  {fmtDateTime(endpoint.last_success_at)} · 最近失败{' '}
                  {fmtDateTime(endpoint.last_failure_at)}
                </p>
              </div>
              <div className="fish-api-row__actions">
                {/* 换密钥与停用都放在这一行：它们都是对「已有配置」的操作 */}
                {!endpoint.disabled && (
                  <button type="button" className="fish-api-revoke" onClick={disable} disabled={busy}>
                    停用
                  </button>
                )}
                <button type="button" className="fish-api-revoke" onClick={rotate} disabled={busy}>
                  换密钥
                </button>
              </div>
            </div>
          </div>

          <h3 className="fish-api-subhead">最近投递</h3>
          {deliveries.length === 0 ? (
            <p className="fish-api-empty">还没有投递记录。</p>
          ) : (
            <div className="fish-api-list">
              {deliveries.map((d) => (
                <div className="fish-api-row" key={d.id}>
                  <div className="fish-api-row__main">
                    <div className="fish-api-row__head">
                      <span className="fish-api-row__label">{d.transfer_id}</span>
                      <span
                        className={`fish-api-badge${d.status === 'delivered' ? ' fish-api-badge--ok' : d.status === 'dead' ? ' fish-api-badge--off' : ''}`}
                      >
                        {STATUS_LABEL[d.status] ?? d.status}
                      </span>
                    </div>
                    <p className="fish-api-row__meta">
                      {fmtDateTime(d.created_at)} · 尝试 {d.attempts} 次
                      {d.last_status_code ? ` · 对方返回 ${d.last_status_code}` : ''}
                      {d.last_error ? ` · ${d.last_error}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
