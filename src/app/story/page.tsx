import { resolvePath } from '@/lib/story-service';
import type { CollectionResult } from '@/lib/story-service';
import { CollectionView } from './CollectionView';

// 故事根合集（/story）—— 合集渲染与子合集页共用 CollectionView。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function StoryRootPage() {
  const result = resolvePath([]);

  const data: CollectionResult =
    result.kind === 'collection'
      ? result.data
      : {
          info: { title: '故事', description: '' },
          children: [],
          breadcrumbs: [],
        };

  return <CollectionView data={data} />;
}
