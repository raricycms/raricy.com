import { requireCoreUser } from '@/lib/guard';
import VoteCreate from './VoteCreate';

export default async function Page() {
  await requireCoreUser();
  return <VoteCreate />;
}
