import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { isCurrentlyBanned } from '@/lib/auth';
import { ymdhms } from '@/lib/format';
import { requireCoreUser } from '@/lib/guard';
import {
  SAVED_MESSAGE_MAX,
  listSavedMessages,
  type SavedMessageItem,
} from '@/lib/saved-message-service';
import SavedMessageRemove from './SavedMessageRemove';

// 保存的私聊消息（**不是收藏夹**）。
//
// 【为什么单开一页】收藏夹是「可分享的合辑」：公开夹有 6 位句柄 / 二维码 / [@ID] /
// bot 接口，私密夹也能复制成公开、能导出 JSON。私聊消息恰好相反 —— 只有当事人能看。
// 把两者放进同一个容器，用户就得永远记着「这个夹子里的东西有些不能发」；这里单开
// 一页，整页没有任何分享 / 导出 / 复制入口，隐私模型简单到没有例外。
//
// 【读路径重新判权限】服务层的 listSavedMessages 会对每条重新判：消息是否被删、
// 作者是否注销、频道是否仍是私聊、我是否还是成员。拿不到就给占位，绝不回退到正文。
//
// 【禁言】与 /api/chat/* 同档：讨论接口在禁言时连读都拦（api/chat/_auth.ts），
// 所以这页也要拦 —— 否则保存箱就是禁言的读取旁路。
export const dynamic = 'force-dynamic';

interface SearchParams {
  /** 保存行 id 游标（不是消息 id）—— 上一页最后一条的 savedId。 */
  before?: string;
}

function parseCursor(raw: unknown): number | undefined {
  const s = typeof raw === 'string' ? raw : '';
  return /^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined;
}

function Item({ item }: { item: SavedMessageItem }) {
  const removed = item.state !== 'ok';
  const linkable = item.state === 'ok' && item.channelId != null;

  const body = (
    <>
      <span className="saved-msg__title">
        {item.state === 'deleted'
          ? '该消息已删除'
          : item.state === 'forbidden'
            ? '该消息已不可查看'
            : item.preview || '（空消息）'}
      </span>
      <span className="saved-msg__meta">
        {item.channelTitle ? `与 ${item.channelTitle} 的私聊` : ''}
        {item.authorName ? ` · ${item.authorName}` : ''}
      </span>
    </>
  );

  return (
    <li className={`saved-msg${removed ? ' saved-msg--unavailable' : ''}`}>
      <div className="saved-msg__main">
        {linkable ? (
          <Link
            className="saved-msg__link"
            href={`/chat?channel=${encodeURIComponent(item.channelId!)}&message=${item.messageId}`}
          >
            {body}
          </Link>
        ) : (
          <div className="saved-msg__link saved-msg__link--disabled">{body}</div>
        )}
        <span className="saved-msg__time numeric">{ymdhms(item.savedAt)}</span>
      </div>
      <SavedMessageRemove messageId={item.messageId} />
    </li>
  );
}

export default async function SavedMessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCoreUser();
  // 与讨论接口同一道禁言闸（见文件头）。
  if (isCurrentlyBanned(user)) forbidden();

  const sp = await searchParams;
  const page = await listSavedMessages(user.id, {
    before: parseCursor(sp.before),
    limit: 50,
  });

  return (
    <div className="container saved-page">
      <div className="saved-page__head">
        <h1 className="saved-page__title">保存的消息</h1>
        <span className="saved-page__count numeric">
          {page.total} / {SAVED_MESSAGE_MAX}
        </span>
      </div>
      <p className="saved-page__hint">
        只有自己看得到，不会导出、不会被分享。消息被删除后会显示占位，点进去跳到原会话。
      </p>

      {page.items.length === 0 ? (
        <div className="saved-page__empty">
          还没有保存的消息。在私聊消息上右键（手机长按）→「保存」，就会出现在这里。
        </div>
      ) : (
        <ul className="saved-msg-list">
          {page.items.map((item) => (
            <Item key={item.savedId} item={item} />
          ))}
        </ul>
      )}

      {page.hasMore && page.nextBefore != null && (
        <p className="saved-page__more">
          <Link href={`/chat/saved?before=${page.nextBefore}`}>加载更早的</Link>
        </p>
      )}

      <p className="saved-page__back">
        <Link href="/chat">← 返回讨论</Link>
      </p>
    </div>
  );
}
