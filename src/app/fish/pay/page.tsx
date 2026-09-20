import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext, safeExternalReturnUrl } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import {
  findTransferTargetByUsername,
  makeOrderKeyBase,
  ORDER_RE,
  TRANSFER_NOTE_MAX,
} from '@/lib/fish-market-service';
import PayForm from '../PayForm';
import PayErrorCard from '../PayError';

// 收银台 —— 站外商户把用户送到这里付款（协议见 docs/bot/fish-bot.md §9）。
//
// 设计要点：
//   · 参数全部来自 URL、**一律不可信**：只用于展示与预填；钱的事一律由服务端复核
//     （金额格式、收款人存在性、余额、限额）。
//   · 未登录 → 跳本站登录页（`next` 带回本页完整参数）—— 密码只输入在 raricy 的
//     域名下，商户站点从头到尾看不到它。
//   · 付款本身还要**再输一次本人密码**（step-up，见 PayForm）。
//   · 不入搜索引擎索引（这是一个带参数的支付页，被索引没有任何好处）。
export const dynamic = 'force-dynamic';

export const metadata = {
  title: '支付',
  robots: { index: false, follow: false },
};

/** 最多 1 位小数的正数 —— 与 fish-units 的口径一致（前端先挡一道，服务端仍会复核）。 */
const AMOUNT_RE = /^\d+(\.\d)?$/;
/** 商户名只用于展示：长度设上限、去掉控制字符（React 会转义，这里只防刷屏）。 */
const MERCHANT_MAX = 40;

type RawParams = Record<string, string | string[] | undefined>;

/** 取同名参数的第一个值（链接里同名键重复时以第一个为准）。 */
function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** 由参数重建查询串，用于登录回跳（不能直接用原始 URL：拿不到未解析的 source）。 */
function rebuildQuery(params: RawParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const value = first(v);
    if (value) qs.set(k, value);
  }
  return qs.toString();
}

/** 参数不合法时的统一展示（卡片样式与 /fish/collect 共用，见 ../PayError）。 */
function PayError({ message }: { message: string }) {
  return (
    <PayErrorCard
      heading="支付"
      title="无法发起支付"
      message={message}
      hint={
        <>
          请回到发起支付的站点重新进入，或
          <Link href="/fish"> 前往我的小鱼干</Link>。
        </>
      }
    />
  );
}

export default async function FishPayPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;

  const toUsername = first(params.to).trim();
  const amountRaw = first(params.amount).trim();
  const noteRaw = first(params.note).trim();
  const merchantRaw = first(params.from).trim();
  const returnRaw = first(params.return).trim();
  const orderRaw = first(params.order).trim();

  // ── 参数校验（顺序：先格式、后存在性）────────────────────────────────────
  if (!toUsername) return <PayError message="缺少收款人参数（to）。" />;
  if (!AMOUNT_RE.test(amountRaw) || Number(amountRaw) <= 0) {
    return <PayError message="金额参数无效（需为大于 0、最多 1 位小数的数字）。" />;
  }
  // 金额位数上界：AMOUNT_RE 的 \d+ 没有长度限制，而金额会参与拼幂等键（见下面 orderKeyBase）。
  // 不设上界时，28 位以上的金额会让幂等键超过 48 字上限，用户拿到的是一句
  // 「幂等键格式不合法」—— 报的是内部实现，与他的输入看不出任何关系。
  // 16 位（最多 1 位小数）直到 10^14 条鱼干，远超任何真实余额。
  if (amountRaw.length > 16) {
    return <PayError message="金额参数无效（数字过长）。" />;
  }
  if (noteRaw.length > TRANSFER_NOTE_MAX) {
    return <PayError message={`备注太长（最多 ${TRANSFER_NOTE_MAX} 个字）。`} />;
  }
  // 订单号非法 → **明确报错，不静默忽略**。忽略等于悄悄丢掉去重保护：
  // 用户刷新页面再付一次就是第二笔真付款，而商户不会收到任何信号。
  if (orderRaw && !ORDER_RE.test(orderRaw)) {
    return <PayError message="订单号参数无效（最多 32 位，仅字母数字与 _ . : -）。" />;
  }

  const recipient = await findTransferTargetByUsername(toUsername);
  if (!recipient) return <PayError message="收款人不存在（商户链接里的用户名有误）。" />;

  const amount = Number(amountRaw);
  const merchant = merchantRaw.slice(0, MERCHANT_MAX).replace(/[\u0000-\u001f\u007f]/g, '');
  const returnUrl = safeExternalReturnUrl(returnRaw);

  // 商户给了订单号 → 由服务层算出稳定的幂等键基（收款人 + 订单号，**不含金额**）。
  // 取舍与长度核算都在 makeOrderKeyBase 的注释里，这里不重复。
  const orderKeyBase = orderRaw ? makeOrderKeyBase(recipient.id, orderRaw) : null;

  // ── 未登录：跳本站登录页（把本页完整参数带回 next）──────────────────────
  const user = await getCurrentUser();
  if (!user) {
    redirect(loginUrlWithNext(`/fish/pay?${rebuildQuery(params)}`));
  }

  if (recipient.id === user.id) return <PayError message="不能给自己付款。" />;

  const balance = await getBalance(user.id);

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        支付
      </h1>

      <PayForm
        variant="cashier"
        toId={recipient.id}
        toUsername={recipient.username}
        toFrameUrl={recipient.frame_url}
        amount={amount}
        note={noteRaw}
        merchant={merchant}
        returnUrl={returnUrl}
        balance={balance}
        keyBase={orderKeyBase}
      />
    </div>
  );
}
