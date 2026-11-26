import { isCoreUser, isOwner } from '../auth';
import { getClip } from '../clipboard-query';
import { getVoteDetail } from '../vote-service';
import { getPublicFavorite } from '../favorite-service';
import { MAX_CARD_ITEMS, isFavoriteId } from '../favorite-refs';
import { rateLimit, RULES } from '../rate-limit';
import type { ReferenceMode, ReferenceReader, ResolvedReference } from './ref-types';

interface ReferenceViewer {
  id: string;
  role?: string;
  archivedAt?: Date | null;
}

/** Each factory is request-scoped. Direct service calls retain the API's core+ gate. */
export function createServiceReferenceReader(
  mode: ReferenceMode,
  viewer: ReferenceViewer | null,
  clientIp?: string,
): ReferenceReader {
  return async (slot): Promise<ResolvedReference | undefined> => {
    if (slot.kind === 'image' || slot.kind === 'audio') return undefined;
    if (mode === 'external') return undefined;
    if (mode === 'expand' && !isCoreUser(viewer)) return { status: 'forbidden' };
    if (!/^[A-Za-z0-9]+$/.test(slot.ref)) return undefined;
    try {
      if (slot.kind === 'clipboard') {
        if (slot.ref.length !== 8) return undefined;
        const result = await getClip(
          slot.ref,
          viewer!.id,
          isOwner(viewer),
        );
        if (!result.ok) {
          return { status: result.reason === 'forbidden' ? 'forbidden' : 'error' };
        }
        const clip = result.clip;
        // 只交正文：渲染方一律内联内容，没有「格式不支持就退化」的分支可走。
        return { status: 'ready', content: clip.content, version: clip.version };
      }
      if (slot.kind === 'vote') {
        if (slot.ref.length !== 9) return undefined;
        const vote = await getVoteDetail(slot.ref, viewer!.id);
        if (!vote) return { status: 'error' };
        return {
          status: 'ready',
          payload: {
            // 不写 `id`：parseVoteData 只读下面这些展示字段，投票 id 由宿主 ref 决定（R3-140）。
            title: vote.title, is_locked: vote.isLocked,
            total_votes: vote.totalVotes, user_voted: vote.userVoted,
            options: vote.options.map(({ id, label, count, percentage }) => ({ id, label, count, percentage })),
          },
        };
      }
      // 6 位白名单只认 favorite-refs 那一处（R3-240），别在这里手写正则。
      if (!isFavoriteId(slot.ref)) return undefined;
      if (clientIp && !rateLimit(`spider:fav:ip:${clientIp}`, RULES.spiderFavoritePerIp).allowed) {
        return { status: 'error' };
      }
      const result = await getPublicFavorite(slot.ref);
      if (!result.ok) return { status: 'error' };
      return {
        status: 'ready',
        payload: {
          title: result.favorite.title, authorName: result.favorite.authorName,
          count: result.favorite.items.length,
          items: result.favorite.items.slice(0, MAX_CARD_ITEMS),
        },
      };
    } catch {
      // Availability failures are local to this reference; private details stay server-side.
      return { status: 'error' };
    }
  };
}
