import type { ReactNode } from 'react';
import { parseBubbleKey } from '@/lib/bubble-refs';

// 聊天、设置与商城预览共用。这里只映射白名单样式，不判断持有或到期。
export default function ChatBubble({ bubbleKey, mentioned = false, children }: {
  bubbleKey: string | null; mentioned?: boolean; children: ReactNode;
}) {
  return (
    <div className={`chat-msg__content${mentioned ? ' chat-msg__content--mention' : ''}`}
      data-bubble={parseBubbleKey(bubbleKey) ?? undefined}>
      {children}
    </div>
  );
}
