import { requireCoreUser } from '@/lib/guard';
import ClipboardMenu from './ClipboardMenu';

export default async function Page() {
  await requireCoreUser();
  return <ClipboardMenu />;
}
