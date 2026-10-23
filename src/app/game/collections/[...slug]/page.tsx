import { Fragment } from 'react';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  GAMES,
  childCollections,
  collectionByPath,
  collectionHref,
  collectionPath,
} from '@/lib/game-catalog';
import GameCard from '../../GameCard';
import GameCollectionCard from '../../GameCollectionCard';

type Props = { params: Promise<{ slug: string[] }> };

/** 解析 URL 段；`canonical` 为 false 时页面会永久跳到规范路径（旧地址靠这条救）。 */
function resolve(slugs: string[]) {
  const collection = collectionByPath(slugs);
  if (!collection) return null;
  const path = collectionPath(collection.id);
  const canonical = path.length === slugs.length && path.every((entry, index) => entry.id === slugs[index]);
  return { collection, path, canonical };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const found = resolve(slug);
  return { title: found ? `${found.collection.title} · 玩具 · 聪明山` : '合集不存在' };
}

export default async function GameCollectionPage({ params }: Props) {
  const { slug } = await params;
  const found = resolve(slug);
  if (!found) notFound();
  if (!found.canonical) permanentRedirect(collectionHref(found.collection.id));
  const { collection, path } = found;
  const children = childCollections(collection.id);
  const games = GAMES.filter((game) => game.collectionId === collection.id);
  return (
    <div className="container game-menu">
      <nav className="game-breadcrumb" aria-label="合集路径">
        <Link href="/game">玩具</Link>
        {path.map((entry) => (
          <Fragment key={entry.id}>
            <span aria-hidden="true">/</span>
            {entry.id === collection.id
              ? <span aria-current="page">{entry.title}</span>
              : <Link href={collectionHref(entry.id)}>{entry.title}</Link>}
          </Fragment>
        ))}
      </nav>
      <h1>{collection.title}</h1>
      <div className="game-grid">
        {games.map((game) => <GameCard key={game.id} game={game} />)}
      </div>
      {children.length > 0 && (
        <section className="game-collections" aria-labelledby="game-subcollections-title">
          <h2 id="game-subcollections-title">子合集</h2>
          <div className="game-grid">
            {children.map((child) => <GameCollectionCard key={child.id} collection={child} />)}
          </div>
        </section>
      )}
    </div>
  );
}
