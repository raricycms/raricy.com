import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { listFishTokens } from '@/lib/fish-token-service';
import { nowForDb } from '@/lib/db-time';
import FishApiClient, { type TokenRow } from './FishApiClient';

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

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        鱼干接口
      </h1>
      <p className="market-subtitle">
        把机器人接进来：用<strong>只读凭据</strong>查余额与流水，不必再让它拿你的账号密码。
      </p>

      <section className="fish-api-section">
        <div className="market-card__head">
          <span className="market-card__balance-label">只读凭据</span>
        </div>
        <p className="market-field__hint">
          凭据只能查余额与流水，<strong>不能转账</strong>。它可单独吊销，且改密码不会作废它
          —— 所以它比把密码交给脚本安全。有效期一年，到期后需重新签发。
        </p>

        <FishApiClient initialTokens={initialTokens} />
      </section>

      <p className="market-foot">
        <Link href="/fish/transactions?type=transfer_all" className="market-foot__link">
          查看转账记录
        </Link>
      </p>
    </div>
  );
}
