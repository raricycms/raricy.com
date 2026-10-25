import { isCoreUser, isOwner } from '../auth';
import { getClip } from '../clipboard-service';
import { getVoteDetail } from '../vote-service';
import { getPublicFavorite } from '../favorite-service';
import { MAX_CARD_ITEMS } from '../favorite-refs';
import { parseContentFormat } from '../content-format';
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
    if (mode === 'external' && slot.kind !== 'clipboard') return undefined;
    if (mode === 'expand' && !isCoreUser(viewer)) return { status: 'forbidden' };
    if (!/^[A-Za-z0-9]+$/.test(slot.ref)) return undefined;
    try {
      if (slot.kind === 'clipboard') {
        if (slot.ref.length !== 8) return undefined;
        const result = await getClip(
          slot.ref,
          mode === 'expand' ? viewer!.id : undefined,
          mode === 'expand' && isOwner(viewer),
        );
        if (!result.ok) {
          return mode === 'external' ? undefined : { status: result.reason === 'forbidden' ? 'forbidden' : 'error' };
        }
        if (mode === 'external' && !result.clip.publicity) return undefined;
        const clip = result.clip as typeof result.clip & { format?: unknown };
        const format = parseContentFormat(clip.format);
        if (!format) return mode === 'external' ? undefined : { status: 'error' };
        return {
          status: 'ready', title: clip.title, format, content: clip.content,
          version: clip.version,
          payload: { href: `/clipboard/${slot.ref}`, title: clip.title },
        };
      }
      if (slot.kind === 'vote') {
        if (slot.ref.length !== 9) return undefined;
        const vote = await getVoteDetail(slot.ref, viewer!.id);
        if (!vote) return { status: 'error' };
        return {
          status: 'ready', title: vote.title,
          payload: {
            id: vote.id, title: vote.title, is_locked: vote.isLocked,
            total_votes: vote.totalVotes, user_voted: vote.userVoted,
            options: vote.options.map(({ id, label, count, percentage }) => ({ id, label, count, percentage })),
          },
        };
      }
      if (!/^\d{6}$/.test(slot.ref)) return undefined;
      if (clientIp && !rateLimit(`spider:fav:ip:${clientIp}`, RULES.spiderFavoritePerIp).allowed) {
        return { status: 'error' };
      }
      const result = await getPublicFavorite(slot.ref);
      if (!result.ok) return { status: 'error' };
      return {
        status: 'ready', title: result.favorite.title,
        payload: {
          title: result.favorite.title, authorName: result.favorite.authorName,
          href: `/favorite/${slot.ref}`, count: result.favorite.items.length,
          items: result.favorite.items.slice(0, MAX_CARD_ITEMS),
        },
      };
    } catch {
      // Availability failures are local to this reference; private details stay server-side.
      return mode === 'external' ? undefined : { status: 'error' };
    }
  };
}
