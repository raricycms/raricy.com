import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { listFishTokens } from '@/lib/fish-token-service';
import { getWebhookEndpoint, listRecentDeliveries } from '@/lib/fish-webhook-service';
import { nowForDb } from '@/lib/db-time';
import PageHeader from '@/app/components/PageHeader';
import FishApiClient, { type TokenRow } from './FishApiClient';
import FishWebhookPanel, {
  type WebhookEndpointView,
  type DeliveryRow,
} from './FishWebhookPanel';

// 鱼干接口 —— 机器人接入的自助页（只读凭据；回调地址见第 3 批）。
//
// 定位：站外开发者自己就能把机器人接上来，不必找站长代劳。在此之前唯一的口子是
// 「把账号密码发给脚本」，既是全权限又是一把不可单独吊销的钥匙。
//
// 权限档位：登录即可（与 /fish 面板、签到、转账同档）—— 这是用户对自己数据的读取权，
// 不涉及任何写钱的动作，不要求 core+。
//
// 入口刻意**不放在** /fish 的 `.fish-card__actions` 那一行：那一行被
// tests/e2e/fish-layout.spec.ts 硬断言为 3 颗（三颗必须同行的几何也钉着）。
// 入口在 /fish/market 页脚与 /settings。
export const dynamic = 'force-dynamic';

export const metadata = {
  title: '鱼干接口',
  robots: { index: false, follow: false },
};

export default async function FishApiPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/api'));

  // 首屏直接给数据 —— 列表不必等 JS 加载完才出现。
  // 这里也不复用路由的 DTO：那个形状是**对外契约**（snake_case），页面自己算
  // 「过期了没」即可，两者不必强行同形。
  const rows = await listFishTokens(user.id);
  const now = nowForDb().getTime();
  const initialTokens: TokenRow[] = rows.map((t) => ({
    id: t.id,
    label: t.label,
    scopes: t.scopes,
    created_at: t.createdAt?.toISOString() ?? null,
    expires_at: t.expiresAt.toISOString(),
    last_used_at: t.lastUsedAt?.toISOString() ?? null,
    revoked_at: t.revokedAt?.toISOString() ?? null,
    expired: t.expiresAt.getTime() <= now,
  }));

  const [endpointRow, deliveryRows] = await Promise.all([
    getWebhookEndpoint(user.id),
    listRecentDeliveries(user.id, 10),
  ]);
  const initialEndpoint: WebhookEndpointView | null = endpointRow
    ? {
        url: endpointRow.url,
        disabled: !!endpointRow.disabledAt,
        disabled_at: endpointRow.disabledAt?.toISOString() ?? null,
        consecutive_failures: endpointRow.consecutiveFailures,
        last_success_at: endpointRow.lastSuccessAt?.toISOString() ?? null,
        last_failure_at: endpointRow.lastFailureAt?.toISOString() ?? null,
        created_at: endpointRow.createdAt?.toISOString() ?? null,
      }
    : null;
  const initialDeliveries: DeliveryRow[] = deliveryRows.map((d) => ({
    id: d.id,
    delivery_id: d.deliveryId,
    transfer_id: d.transferId,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    last_error: d.lastError,
    last_status_code: d.lastStatusCode,
    delivered_at: d.deliveredAt?.toISOString() ?? null,
    created_at: d.createdAt?.toISOString() ?? null,
  }));

  return (
    <div className="content-wrapper fish-page">
      <PageHeader
        title="鱼干接口"
        back={{ href: '/settings#developer', label: '返回设置' }}
        description="把机器人接进来，不必再让它拿你的账号密码。"
        actions={<Link href="/fish/transactions?type=transfer_all" className="page-header__action">转账记录</Link>}
      />

      <section className="fish-api-section" aria-labelledby="fish-api-token-title">
        <h2 className="fish-api-section__title" id="fish-api-token-title">只读凭据</h2>
        <p className="market-field__hint">
          只能查余额与流水，<strong>不能转账或提现</strong>。有效期一年，到期需重新签发；
          可随时吊销，吊销立即生效。改密码不会作废它。
        </p>

        {!isCoreUser(user) && <p className="market-field__hint">当前账号未取得成员资格，可查阅和吊销已有凭据。<Link href="/authentic">认证成员资格</Link></p>}
        <FishApiClient initialTokens={initialTokens} canCreate={isCoreUser(user)} />
      </section>

      <section className="fish-api-section" aria-labelledby="fish-api-webhook-title">
        <h2 className="fish-api-section__title" id="fish-api-webhook-title">收款回调</h2>
        <p className="market-field__hint">
          登记一个地址，有人给你转账时我们主动推一条通知过去 —— 不必再轮询流水。
          投递会重试，但<strong>可能重复</strong>，请按请求头里的投递编号去重。
        </p>

        <FishWebhookPanel initialEndpoint={initialEndpoint} initialDeliveries={initialDeliveries} canConfigure={isCoreUser(user)} />
      </section>
    </div>
  );
}
