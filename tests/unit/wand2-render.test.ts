import { describe, expect, it, vi } from 'vitest';
import { render, type Assets, type Frame } from '../../src/games/wand2/render';
import type { Facing, Player, Snapshot } from '../../shared/wand2/protocol';
import spriteLayout from '../../public/static/games/wand2/sprite-layout.json';

function scene(overrides: Partial<Player> = {}, previousX = 100, previousY = 200) {
  const image = (size = 1024) => ({ complete: true, naturalWidth: size, naturalHeight: size }) as HTMLImageElement;
  const assets: Assets = { character: image(), attack: image(spriteLayout.attackCellSize * 4), world: image() };
  const drawImage = vi.fn(), scale = vi.fn(), translate = vi.fn(), noop = () => {};
  const context = { canvas: { width: 960, height: 640 }, drawImage, scale, setTransform: noop, clearRect: noop, save: noop,
    translate, restore: noop, beginPath: noop, ellipse: noop, fill: noop, stroke: noop, arc: noop,
    measureText: () => ({ width: 20 }), roundRect: noop, fillText: noop } as unknown as CanvasRenderingContext2D;
  const p: Player = { id: 'a', name: '', x: 100, y: 200, facing: 0, moving: false, attack: 0, hurt: 0, catnip: 0, ...overrides };
  const current: Snapshot = { type: 'wand2.snapshot', tick: 1, players: [p], slimes: [], leaderboard: [] };
  const frame: Frame = { previous: { ...current, players: [{ ...p, x: previousX, y: previousY }] }, current, at: 1001 };
  const ground = {} as HTMLCanvasElement;
  return { assets, drawImage, scale, translate, frame,
    draw(now: number, compact = false, ownId = '') { render(context, assets, ground, frame, ownId, now, compact, []); } };
}

describe('Wand 2 镜头跟随', () => {
  it('小屏镜头在快照之间连续移动，角色保持居中，下一份快照到达时不跳变', () => {
    const s = scene({ x: 420, y: 320 }, 400, 300);
    for (const [now, expectedX, expectedY] of [[1000, -120, -90], [1001, -120, -90], [1026, -130, -100], [1051, -140, -110], [1101, -140, -110]]) {
      s.draw(now, true, 'a');
      const [cx, cy] = s.translate.mock.calls.at(-1)!;
      expect([cx, cy]).toEqual([expectedX, expectedY]);
      const character = s.drawImage.mock.calls.at(-1)!;
      expect(character[5] + 44 + cx).toBeCloseTo(280);
      expect(character[6] + 88 * .9 - 4 + cy).toBeCloseTo(210);
    }
    s.frame.previous = s.frame.current;
    s.frame.current = { ...s.frame.current, tick: 2, players: [{ ...s.frame.current.players[0], x: 440, y: 340 }] };
    s.frame.at = 1101;
    s.draw(1101, true, 'a');
    expect(s.translate).toHaveBeenLastCalledWith(-140, -110);
    s.draw(1126, true, 'a');
    expect(s.translate).toHaveBeenLastCalledWith(-150, -120);
  });

  it('小屏镜头仍限制在地图边界，大屏保持全地图视角', () => {
    for (const [x, y, expectedX, expectedY] of [[20, 20, 0, 0], [940, 620, -400, -220]]) {
      const s = scene({ x, y }, x, y); s.draw(1026, true, 'a');
      const [cx, cy] = s.translate.mock.calls.at(-1)!;
      expect(cx).toBeCloseTo(expectedX); expect(cy).toBeCloseTo(expectedY);
      s.draw(1026, false, 'a');
      const [desktopX, desktopY] = s.translate.mock.calls.at(-1)!;
      expect(desktopX).toBeCloseTo(0); expect(desktopY).toBeCloseTo(0);
    }
  });

  it('角色首次出现时，镜头直接使用当前位置', () => {
    const s = scene({ x: 420, y: 320 }); s.frame.previous.players = [];
    s.draw(1001, true, 'a');
    expect(s.translate).toHaveBeenLastCalledWith(-140, -110);
  });
});

describe('Wand 2 精灵播放', () => {
  it('快照时间略晚于动画帧时间时，四方向待机都不误选挥剑表，也不向后插值', () => {
    for (const facing of [0, 1, 2, 3] as Facing[]) {
      const s = scene({ facing }, 90); s.draw(1000);
      const character = s.drawImage.mock.calls[1];
      expect(character[0]).toBe(s.assets.character);
      expect(character[1]).toBe(0); expect(character[2]).toBe(facing * 256);
      expect(character[5]).toBe(90 - 44);
    }
  });

  it('真实攻击按剩余时间播放，结束后回到角色表，初始帧不会越过表格左边界', () => {
    const beginning = scene({ attack: 360 }); beginning.draw(1000);
    expect(beginning.drawImage.mock.calls[1][0]).toBe(beginning.assets.attack);
    expect(beginning.drawImage.mock.calls[1][1]).toBe(0);
    const ended = scene({ attack: 50 }); ended.draw(1101);
    expect(ended.drawImage.mock.calls[1][0]).toBe(ended.assets.character);
  });

  it('左右行走使用各自的原绘帧，保持右手持剑，不做水平镜像', () => {
    for (const facing of [1, 2] as Facing[]) {
      const s = scene({ facing, moving: true }); s.draw(1431);
      expect(s.scale).not.toHaveBeenCalled();
      expect(s.drawImage.mock.calls[1][0]).toBe(s.assets.character);
      expect(s.drawImage.mock.calls[1][1]).toBe(2 * 256);
      expect(s.drawImage.mock.calls[1][2]).toBe(facing * 256);
    }
  });

  it('四方向的攻击使用实际留白单元切帧，并补偿显示大小', () => {
    for (const facing of [0, 1, 2, 3] as Facing[]) {
      for (let col = 0; col < 4; col++) {
        const s = scene({ facing, attack: 360 - col * 90 }); s.draw(1001);
        const draw = s.drawImage.mock.calls[1];
        expect(draw.slice(0, 5)).toEqual([s.assets.attack, col * 384, facing * 384, 384, 384]);
        expect(draw.slice(7)).toEqual([144, 144]);
      }
    }
  });
});
