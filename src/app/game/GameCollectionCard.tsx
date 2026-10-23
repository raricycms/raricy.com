import Link from 'next/link';
import { FlaskConical, Scissors } from 'lucide-react';
import { collectionHref, type GameCollection } from '@/lib/game-catalog';

/** 合集卡片。图标按 `GameCollection.icon` 选；新增一种图标时在这里加一支。 */
export default function GameCollectionCard({ collection }: { collection: GameCollection }) {
  return (
    <Link href={collectionHref(collection.id)} className="game-collection">
      {collection.icon === 'craft' ? <Scissors aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}
      <h3>{collection.title}</h3>
      <span className="game-action">查看合集</span>
    </Link>
  );
}
