// 玩具合集清单的层级约束：URL 由 `parentId` 父链推出来，清单里没有第二份 href。
//
// 这些用例守的是「静默」那类错：把手工间从顶层挪到测试下面，只改一行 parentId，
// 而旧地址 / 嵌套页 / 面包屑 / 返回链接全部跟着派生量走。反过来，若谁在清单里
// 又塞回一个 href、或让某个 parentId 指向不存在的合集，下面的用例会先红。

import { describe, expect, it } from 'vitest';
import {
  GAME_COLLECTIONS,
  GAMES,
  childCollections,
  collectionByPath,
  collectionHref,
  collectionPath,
  gameCollection,
  topLevelCollections,
} from '@/lib/game-catalog';

describe('玩具合集：嵌套清单', () => {
  it('合集 id 唯一，parentId 都指得到，且没有环（父链一定收在同一条顶层）', () => {
    const ids = GAME_COLLECTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of GAME_COLLECTIONS) {
      const path = collectionPath(entry.id);
      expect(path[0].parentId, entry.id).toBeNull();
      expect(path.at(-1)!.id, entry.id).toBe(entry.id);
      expect(new Set(path.map((node) => node.id)).size, entry.id).toBe(path.length);
    }
  });

  it('清单里只登记 parentId 这一份结构，不存 href（存了迟早漂）', () => {
    for (const entry of GAME_COLLECTIONS) expect(entry).not.toHaveProperty('href');
  });

  it('URL 由父链推出：顶层一段，子合集两段', () => {
    expect(collectionPath('craft').map((entry) => entry.id)).toEqual(['craft']);
    expect(collectionHref('test')).toBe('/game/collections/test');
    expect(collectionHref('craft')).toBe('/game/collections/craft');
  });

  it('玩具首页只陈列顶层合集；子合集只在父合集页里出现', () => {
    expect(topLevelCollections().map((entry) => entry.id)).toEqual(['test', 'craft']);
    expect(childCollections('test').map((entry) => entry.id)).toEqual([]);
    expect(childCollections('craft')).toEqual([]);
  });

  it('URL 段按 id 链解析；非规范写法也解析出来，由页面负责永久重定向', () => {
    expect(collectionByPath([])).toBeNull();
    expect(collectionByPath(['unknown'])).toBeNull();
    expect(collectionByPath(['test'])?.id).toBe('test');
    expect(collectionByPath(['test', 'craft'])?.id).toBe('craft');
    // 旧的顶层地址：手工间还在顶层时的书签。解析得出来，页面才知道往哪跳。
    expect(collectionByPath(['craft'])?.id).toBe('craft');
    // 父链倒置 / 多一段不存在的，都解析失败。
    expect(collectionByPath(['craft', 'test'])).toBeNull();
    expect(collectionByPath(['test', 'unknown'])).toBeNull();
  });
});

describe('玩具清单：与合集的引用关系', () => {
  it('每款游戏的 collectionId 都指向存在的合集（null = 玩具首页直接陈列）', () => {
    for (const game of GAMES) {
      if (game.collectionId === null) continue;
      expect(gameCollection(game.collectionId), game.id).toBeDefined();
    }
  });

  it('手工间独立陈列，三款手工的归属不变', () => {
    expect(gameCollection('craft')?.parentId).toBeNull();
    expect(GAMES.filter((game) => game.collectionId === 'craft').map((game) => game.id))
      .toEqual(['loom', 'papercut', 'marbling']);
  });
});
