import type { Metadata } from 'next';
import { GAMES, topLevelCollections } from '@/lib/game-catalog';
import GameCard from './GameCard';
import GameCollectionCard from './GameCollectionCard';
import { gamesVisibleToViewer } from './game-viewer';

export const metadata: Metadata = { title: '玩具 · 聪明山' };

export default async function GameMenuPage() {
  const games = await gamesVisibleToViewer(GAMES.filter((game) => game.collectionId === null));
  return (
    <div className="container game-menu">
      <h1>玩具</h1>
      <div className="game-grid">
        {games.map((game) => <GameCard key={game.id} game={game} />)}
      </div>
      <section className="game-collections" aria-labelledby="game-collections-title">
        <h2 id="game-collections-title">合集</h2>
        <div className="game-grid">
          {topLevelCollections().map((collection) => (
            <GameCollectionCard key={collection.id} collection={collection} />
          ))}
        </div>
      </section>
    </div>
  );
}
