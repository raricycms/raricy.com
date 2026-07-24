import type { Metadata } from 'next';
import { requireCoreUser } from '@/lib/guard';
import UploadForm from './UploadForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '上传云剪贴板 - Raricy.com',
};

// 上传云剪贴板
export default async function Page() {
  await requireCoreUser();
  return (
    <div className="clipboard-page">
      <h1 className="clipboard-title">上传云剪贴板</h1>
      <UploadForm />
    </div>
  );
}