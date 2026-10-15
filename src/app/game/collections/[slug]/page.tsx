import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { GAME_COLLECTIONS, GAMES } from '@/lib/game-catalog';
import GameCard from '../../GameCard';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const collection = GAME_COLLECTIONS.find((entry) => entry.id === slug);
  return { title: collection ? `${collection.title} · 玩具 · 聪明山` : '合集不存在' };
}

export default async function GameCollectionPage({ params }: Props) {
  const { slug } = await params;
  const collection = GAME_COLLECTIONS.find((entry) => entry.id === slug);
  if (!collection) notFound();
  return (
    <div className="container game-menu">
      <Link href="/game" className="game-back">返回玩具</Link>
      <h1>{collection.title}</h1>
      <div className="game-grid">
        {GAMES.filter((game) => game.collectionId === collection.id).map((game) => <GameCard key={game.id} game={game} />)}
      </div>
    </div>
  );
}
