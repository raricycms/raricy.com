import { describe, expect, it, vi } from 'vitest';
import { render, type Assets, type Frame } from '../../src/games/wand2/render';
import type { Facing, Player, Snapshot } from '../../shared/wand2/protocol';

function scene(overrides: Partial<Player> = {}, previousX = 100) {
  const image = () => ({ complete: true, naturalWidth: 1024, naturalHeight: 1024 }) as HTMLImageElement;
  const assets: Assets = { character: image(), attack: image(), world: image() };
  const drawImage = vi.fn(), scale = vi.fn(), noop = () => {};
  const context = { canvas: { width: 960, height: 640 }, drawImage, scale, setTransform: noop, clearRect: noop, save: noop,
    translate: noop, restore: noop, beginPath: noop, ellipse: noop, fill: noop, stroke: noop, arc: noop,
    measureText: () => ({ width: 20 }), roundRect: noop, fillText: noop } as unknown as CanvasRenderingContext2D;
  const p: Player = { id: 'a', name: '', x: 100, y: 200, facing: 0, moving: false, attack: 0, hurt: 0, catnip: 0, ...overrides };
  const current: Snapshot = { type: 'wand2.snapshot', tick: 1, players: [p], slimes: [], leaderboard: [] };
  const frame: Frame = { previous: { ...current, players: [{ ...p, x: previousX }] }, current, at: 1001 };
  const ground = {} as HTMLCanvasElement;
  return { assets, drawImage, scale, draw(now: number) { render(context, assets, ground, frame, '', now, false, []); } };
}

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
});
