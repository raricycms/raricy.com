import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import TransferPanel from '../market/TransferPanel';
export const dynamic='force-dynamic';
export const metadata={title:'鱼干转账',robots:{index:false,follow:false}};
export default async function TransferPage(){
  const user=await getCurrentUser();
  if(!user) redirect(loginUrlWithNext('/fish/transfer'));
  return <div className="content-wrapper">
    <h1 className="page-title">鱼干转账</h1>
    <TransferPanel balance={await getBalance(user.id)} />
    <p className="market-foot"><Link className="market-foot__link" href="/fish/transactions?type=transfer_all">转账记录</Link></p>
    <p className="market-foot"><Link className="market-foot__link" href="/fish">返回账户</Link></p>
  </div>;
}
