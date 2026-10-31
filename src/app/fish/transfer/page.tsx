import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import PageHeader from '@/app/components/PageHeader';
import TransferPanel from '../market/TransferPanel';
export const dynamic='force-dynamic';
export const metadata={title:'鱼干转账',robots:{index:false,follow:false}};
export default async function TransferPage(){
  const user=await getCurrentUser();
  if(!user) redirect(loginUrlWithNext('/fish/transfer'));
  return <div className="content-wrapper fish-page fish-transfer">
    <PageHeader
      title="鱼干转账"
      back={{ href: '/fish', label: '返回账户' }}
      actions={<Link href="/fish/transactions?type=transfer_all" className="page-header__action">转账记录</Link>}
    />
    <TransferPanel balance={await getBalance(user.id)} />
  </div>;
}
