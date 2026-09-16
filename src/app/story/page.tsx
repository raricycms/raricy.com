import { resolvePath } from '@/lib/story-service';
import type { CollectionResult } from '@/lib/story-service';
import { CollectionView } from './CollectionView';

// 故事根合集（/story）—— 合集渲染与子合集页共用 CollectionView。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 故事区抬头文案：根 info.json 没写 description 时用这句兜底。
 *
 * 【为什么写在这里而不是 instance/stories/info.json】`instance/` 是 gitignored 的
 * 运行时数据 —— 写进去的文案不入库、不可评审，换台机器就没了。根合集是**站级门面**，
 * 抬头文案属于代码而非数据。站长若确实要在 instance/stories/info.json 里自定义，
 * 那份数据仍然优先（这里只是兜底）。
 *
 * 【口径】故事区的小说来自站内作者，不是「本站替别人代发」——一律以「站内作者的原创
 * 作品」叙述。「代发」把作者和作品都推远了：作者成了没露面的投稿人，作品成了本站的
 * 转手货，两头都不体面。
 */
const STORY_INTRO = '收录站内作者创作的原创小说与互动故事，欢迎慢慢读。';

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

  return <CollectionView data={data} fallbackDescription={STORY_INTRO} />;
}
