import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTransactions } from '@/lib/fish-service';
import { signedFish } from '@/lib/fish-amount';
import { ymdhm } from '@/lib/format';
import { TRANSFER_NOTE_MAX } from '@/lib/fish-transfer-service';
import { RULES } from '@/lib/rate-limit';
import PageHeader from '@/app/components/PageHeader';
import TransferPanel from '../market/TransferPanel';
export const dynamic='force-dynamic';
export const metadata={title:'鱼干转账',robots:{index:false,follow:false}};

// 版式：桌面双栏（左 = 转账表单，右 = 最近转账 + 转账说明），窄屏单列。
//
// 【为什么不再让表单贴左占半屏】只放一张 560px 的表单时，容器右半边整块空着
// （1140 容器里空 ~580px），是「全宽抬头 + 半宽主体」的失配。右栏填的是本页真正
// 缺的信息：转账没有撤回入口，而「最近转账」与「不可撤回 / 手续费 / 限频」原先
// 只藏在二次确认弹窗或文档里。两栏的折点用 992px（容器从 960 起步的那一档），
// 布局规则写在 _fish.scss 的 .fish-transfer 块内，别动共用的 .market-card。
export default async function TransferPage(){
  const user=await getCurrentUser();
  if(!user) redirect(loginUrlWithNext('/fish/transfer'));
  const [balance, recent] = await Promise.all([
    getBalance(user.id),
    // 只取转账流水（transfer_all 同时含转出与转入），5 条足够当「上一笔转给谁」的提醒。
    getTransactions(user.id, 1, 5, 'transfer_all'),
  ]);
  return <div className="content-wrapper fish-page fish-transfer">
    <PageHeader
      title="鱼干转账"
      back={{ href: '/fish', label: '返回账户' }}
      actions={<Link href="/fish/transactions?type=transfer_all" className="page-header__action">转账记录</Link>}
    />
    <div className="fish-transfer__layout">
      <TransferPanel balance={balance} />
      <aside className="fish-transfer__aside" aria-label="转账信息">
        <section className="fish-transfer__card" aria-labelledby="transfer-recent-title">
          <h2 className="fish-transfer__card-title" id="transfer-recent-title">最近转账</h2>
          {recent.transactions.length > 0 ? (
            <div className="fish-transfer__tx-list">
              {recent.transactions.map((tx) => (
                <div className="fish-transfer__tx" key={tx.id}>
                  <div className="fish-transfer__tx-text">
                    <span className="fish-transfer__tx-desc">{tx.description || tx.type}</span>
                    <span className="fish-transfer__tx-time numeric">{ymdhm(tx.createdAt)}</span>
                  </div>
                  <span className={`fish-transfer__tx-amount numeric ${tx.amount > 0 ? 'fish-transfer__tx-amount--in' : 'fish-transfer__tx-amount--out'}`}>
                    {signedFish(tx.amount)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="fish-transfer__empty">还没有转账记录。</p>
          )}
        </section>
        <section className="fish-transfer__card" aria-labelledby="transfer-rules-title">
          <h2 className="fish-transfer__card-title" id="transfer-rules-title">转账说明</h2>
          <ul className="fish-transfer__rules">
            <li>到账即时生效，<strong>不可撤回</strong>；转出前请核对收款人与金额。</li>
            <li>手续费 0 鱼干，转账后余额即时更新。</li>
            <li>留言可选，最多 {TRANSFER_NOTE_MAX} 字，收付双方的流水里都能看到。</li>
            <li>
              频率限制：每小时 {RULES.transferHourly.limit} 笔、每天 {RULES.transferDaily.limit} 笔。
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>;
}
