import type { Metadata } from 'next';
import { requireCoreUser } from '@/lib/guard';
import UploadForm from './UploadForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '上传云剪贴板 - Raricy.com',
};

export default async function Page() {
  await requireCoreUser();
  return <UploadForm />;
}
