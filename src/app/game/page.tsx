import Link from 'next/link';
import type { Metadata } from 'next';
import { FlaskConical } from 'lucide-react';
import { GAMES, GAME_COLLECTIONS } from '@/lib/game-catalog';
import GameCard from './GameCard';

export const metadata: Metadata = { title: '玩具 · 聪明山' };

export default function GameMenuPage() {
  return (
    <div className="container game-menu">
      <h1>玩具</h1>
      <div className="game-grid">
        {GAMES.filter((game) => game.collectionId === null).map((game) => <GameCard key={game.id} game={game} />)}
      </div>
      <section className="game-collections" aria-labelledby="game-collections-title">
        <h2 id="game-collections-title">合集</h2>
        <div className="game-grid">
          {GAME_COLLECTIONS.map((collection) => (
            <Link key={collection.id} href={collection.href} className="game-collection">
              <FlaskConical aria-hidden="true" />
              <h3>{collection.title}</h3>
              <span className="game-action">查看合集</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
