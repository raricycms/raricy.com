'use client';

import { useEffect, useRef, useState } from 'react';

// 手工间的音效全部现场合成（和双影同一套理由：不引第三方音频素材）。
// 每个公开方法都静默失败 —— 音效只是反馈，不该让任何一台设备把游戏弄崩。

const MASTER_GAIN = 0.1;
export const SOUND_PREF_KEY = 'craft-sound-muted';

export type CraftSoundName = 'click' | 'snip' | 'drop' | 'lift' | 'swish';

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

  return {
    setMuted(value: boolean) { muted = value; },
    play(name) {
      if (muted) return;
      try {
        if (!audio()) return;
        if (name === 'click') { hiss(0.045, 0.5, 1800); tone(220, 150, 0.07, 0.35, 'triangle'); }
        else if (name === 'snip') { hiss(0.035, 0.45, 3200); hiss(0.03, 0.3, 2400, 0.07); }
        else if (name === 'drop') { tone(420, 180, 0.16, 0.45, 'sine'); }
        else if (name === 'swish') { hiss(0.14, 0.2, 1300); tone(190, 320, 0.14, 0.12, 'sine'); }
        else { hiss(0.22, 0.18, 900); tone(160, 260, 0.22, 0.18, 'sine'); }
      } catch { /* 静默失败 */ }
    },
  };
}

export function useCraftSound() {
  const engine = useRef<SoundEngine | null>(null);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored = false;
    try { stored = window.localStorage.getItem(SOUND_PREF_KEY) === '1'; } catch { /* 没有存储也能玩 */ }
    setMuted(stored);
    engine.current = createEngine(stored);
    setReady(true);
  }, []);

  function toggle() {
    const next = !muted;
    setMuted(next);
    engine.current?.setMuted(next);
    try { window.localStorage.setItem(SOUND_PREF_KEY, next ? '1' : '0'); } catch { /* 静默失败 */ }
  }

  return {
    muted,
    ready,
    toggle,
    play(name: CraftSoundName) { engine.current?.play(name); },
  };
}
