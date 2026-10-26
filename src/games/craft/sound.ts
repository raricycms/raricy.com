'use client';

import { useSyncExternalStore } from 'react';

// 手工间的音效全部现场合成（和双影同一套理由：不引第三方音频素材）。
// 每个公开方法都静默失败 —— 音效只是反馈，不该让任何一台设备把游戏弄崩。
//
// 【为什么是模块级单例，而不是每个组件一个引擎】外框（静音钮）和台面（动作音）是
// 两个组件，但玩家眼里只有一个音箱：静音状态必须共享，否则"点静音后织布还在响"。
// 引擎只在浏览器里才有 AudioContext，模块级持有也就只有一份，不必担心泄漏。

const MASTER_GAIN = 0.1;
export const SOUND_PREF_KEY = 'craft-sound-muted';

export type CraftSoundName =
  | 'click'   // 普通控件
  | 'snip'    // 剪刀咬纸
  | 'thread'  // 梭子穿过经线（一串轻响）
  | 'beat'    // 筘压紧这一行（闷响）
  | 'drop'    // 颜料落水
  | 'swish'   // 针 / 梳子划水
  | 'lay'     // 纸铺到水面
  | 'peel'    // 揭纸
  | 'unfold'  // 展开纸层
  | 'lift'    // 拿起剪刀 / 工具
  | 'done';   // 收边、成品

interface SoundEngine {
  play: (name: CraftSoundName) => void;
  setMuted: (muted: boolean) => void;
}

function createEngine(initialMuted: boolean): SoundEngine {
  let muted = initialMuted;
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;

  function audio(): AudioContext | null {
    try {
      if (typeof window === 'undefined') return null;
      if (!context) {
        const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        context = new Ctor();
        master = context.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(context.destination);
      }
      if (context.state === 'suspended') void context.resume().catch(() => {});
      return context;
    } catch {
      context = null;
      master = null;
      return null;
    }
  }

  function noiseBuffer(ac: AudioContext): AudioBuffer {
    if (!noise) {
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate);
      const channel = noise.getChannelData(0);
      for (let i = 0; i < channel.length; i += 1) channel[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  function tone(from: number, to: number, duration: number, gain: number, type: OscillatorType = 'sine', delay = 0): void {
    const ac = audio();
    if (!ac || !master) return;
    const start = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const volume = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), start + 0.006);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(volume); volume.connect(master);
    osc.start(start); osc.stop(start + duration + 0.03);
    osc.onended = () => { try { osc.disconnect(); volume.disconnect(); } catch { /* 已断开 */ } };
  }

  function hiss(duration: number, gain: number, cutoff: number, delay = 0): void {
    const ac = audio();
    if (!ac || !master) return;
    const start = ac.currentTime + delay;
    const source = ac.createBufferSource();
    source.buffer = noiseBuffer(ac);
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.8;
    const volume = ac.createGain();
    volume.gain.setValueAtTime(Math.max(0.0001, gain), start);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter); filter.connect(volume); volume.connect(master);
    source.start(start); source.stop(start + duration + 0.02);
    source.onended = () => { try { source.disconnect(); filter.disconnect(); volume.disconnect(); } catch { /* 已断开 */ } };
  }

  function play(name: CraftSoundName): void {
    if (muted) return;
    try {
      if (!audio()) return;
      switch (name) {
        case 'click':
          hiss(0.045, 0.5, 1800); tone(220, 150, 0.07, 0.35, 'triangle');
          break;
        case 'snip':
          // 两下极短的金属擦：像剪刀咬合后又松开。
          hiss(0.035, 0.45, 3200); hiss(0.03, 0.3, 2400, 0.07);
          break;
        case 'thread':
          // 梭子穿过经线：高频细擦由弱到强再收，像线被拨开。
          hiss(0.08, 0.12, 5200); hiss(0.07, 0.16, 4200, 0.05); tone(880, 620, 0.1, 0.05, 'sine');
          break;
        case 'beat':
          // 筘压紧：短促的下沉闷响，低频多、尾巴极短。
          tone(150, 62, 0.13, 0.5, 'sine'); hiss(0.05, 0.22, 620);
          break;
        case 'drop':
          tone(420, 180, 0.16, 0.45, 'sine');
          break;
        case 'swish':
          hiss(0.14, 0.2, 1300); tone(190, 320, 0.14, 0.12, 'sine');
          break;
        case 'lay':
          // 纸接触水面：先一下闷的接触声，再一层缓慢的水膜。
          hiss(0.18, 0.14, 700); tone(220, 120, 0.2, 0.2, 'sine', 0.02);
          break;
        case 'peel':
          // 揭起：由低到高的黏连感，比 lay 更亮。
          hiss(0.24, 0.16, 2200); tone(300, 520, 0.22, 0.14, 'sine');
          break;
        case 'unfold':
          // 纸层张开：三声依次更轻的沙沙，模仿逐层放开。
          hiss(0.1, 0.16, 2600); hiss(0.09, 0.12, 3000, 0.07); hiss(0.08, 0.08, 3400, 0.14);
          break;
        case 'lift':
          hiss(0.09, 0.1, 1000); tone(320, 430, 0.09, 0.1, 'sine');
          break;
        default:
          // done：收边 / 成品，一声干净的上行三音。
          tone(523, 523, 0.16, 0.16, 'sine', 0);
          tone(659, 659, 0.16, 0.14, 'sine', 0.1);
          tone(784, 784, 0.34, 0.12, 'sine', 0.2);
          break;
      }
    } catch { /* 静默失败 */ }
  }

  return { setMuted(value: boolean) { muted = value; }, play };
}

// ── 共享状态 ────────────────────────────────────────────────────────────────

let engine: SoundEngine | null = null;
let muted = false;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 首帧必须与 SSR 一致（一律"未静音"），挂载后才读 localStorage。 */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  let stored = false;
  try { stored = window.localStorage.getItem(SOUND_PREF_KEY) === '1'; } catch { /* 没有存储也能玩 */ }
  engine = createEngine(stored);
  if (stored !== muted) { muted = stored; emit(); }
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 给手势回调用的直接播放（不在 React 渲染期调用，无需订阅状态）。 */
export function playCraftSound(name: CraftSoundName): void {
  ensureInitialized();
  engine?.play(name);
}

export function useCraftSound() {
  const isMuted = useSyncExternalStore(subscribe, () => muted, () => false);

  function toggle() {
    ensureInitialized();
    const next = !muted;
    muted = next;
    engine?.setMuted(next);
    try { window.localStorage.setItem(SOUND_PREF_KEY, next ? '1' : '0'); } catch { /* 静默失败 */ }
    emit();
  }

  return {
    muted: isMuted,
    toggle,
    play: playCraftSound,
  };
}
