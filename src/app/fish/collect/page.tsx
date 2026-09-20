import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { findTransferTargetByUsername } from '@/lib/fish-market-service';
import PayErrorCard from '../PayError';
import PayForm from '../PayForm';

// 扫码收款页 —— 别人扫了「鱼干收款码」（见 /api/poster/collect）之后落到这里。
//
// 与收银台 /fish/pay 的分工：那边是**站外商户**带着金额来请你付款（金额由商户定），
// 这边是**个人收款码**（静态码，金额由付款人自己填）。两者前端是同一个组件
// （../PayForm）的两个变体，step-up 密码与幂等键完全共用。
//
// 设计要点：
//   · `to` 来自 URL、**一律不可信**：只用于查出收款人；钱的事一律由服务端复核。
//     查出来的收款人是库里的真实用户，页面展示的是他的真实头像与昵称 ——
//     二维码可以被任何人转发，所以「以这里显示的收款人为准」。
//   · 未登录 → 跳本站登录页（`next` 带回本页参数），登录后原地继续。
//   · 不能给自己付款（与收银台同一条规矩）。
//   · 不入搜索引擎索引。
export const dynamic = 'force-dynamic';

export const metadata = {
  title: '收款',
  robots: { index: false, follow: false },
};

type RawParams = Record<string, string | string[] | undefined>;

/** 取同名参数的第一个值（链接里同名键重复时以第一个为准）。 */
function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** 参数不合法时的统一展示（卡片样式与收银台共用，见 ../PayError）。 */
function CollectError({ message }: { message: string }) {
  return (
    <PayErrorCard
      heading="收款"
      title="无法发起付款"
      message={message}
      hint={
        <>
          请让对方重新出示收款码，或
          <Link href="/fish"> 前往我的小鱼干</Link>。
        </>
      }
    />
  );
}

export default async function FishCollectPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const toUsername = first(params.to).trim();
  if (!toUsername) return <CollectError message="缺少收款人参数（to）。" />;

  const recipient = await findTransferTargetByUsername(toUsername);
  if (!recipient) return <CollectError message="收款人不存在（收款码里的用户名有误）。" />;

  const user = await getCurrentUser();
  if (!user) {
    redirect(loginUrlWithNext(`/fish/collect?to=${encodeURIComponent(toUsername)}`));
  }
  if (recipient.id === user.id) return <CollectError message="这是你自己的收款码，不能给自己付款。" />;

  const balance = await getBalance(user.id);

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        收款
      </h1>

      <PayForm
        variant="collect"
        toId={recipient.id}
        toUsername={recipient.username}
        toFrameUrl={recipient.frame_url}
        // collect 变体不用这两个（金额由付款人填、没有商户）
        amount={0}
        note=""
        merchant=""
        returnUrl={null}
        balance={balance}
      />
    </div>
  );
}
