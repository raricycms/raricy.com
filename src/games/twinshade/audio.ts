// ─────────────────────────────────────────────────────────────────────────────
// audio.ts — 双影的音效：全部 WebAudio 现场合成，不引任何音频素材
//
// 【为什么不用音频文件】仓库的素材纪律是「第三方素材不入库」；钥匙孔里那点音效
// 自己画波形就够了，还省掉一轮加载、一次解码与一份许可证。合成音的参数都在下面
// 几个常量里，改手感只要改数，不用找素材。
//
// 【为什么 AudioContext 要懒创建】浏览器（尤其 Chrome / Safari）在**没有用户手势**
// 时创建或启动 AudioContext 会把它挂在 suspended 上，并在控制台留一条警告；更糟的
// 是 e2e 把 `pageerror` 当失败。所以第一次真正发声时才建，且每次发声前都检查
// `state === 'suspended'` 并 `resume()`（离开标签页 / 手机切后台都会让它回到 suspended）。
//
// 【为什么整段 try/catch】WebAudio 在旧引擎、被策略禁用的页面、以及部分隐私扩展里会
// 直接抛；音效是「锦上添花」，任何异常都不该让游戏崩掉，更不该冒到 window.onerror。
// 因此每个公开方法都是「静默失败」：没有 AudioContext 就什么都不做。
// ─────────────────────────────────────────────────────────────────────────────

import type { SoundHandle } from './ui-types';

/**
 * 主增益。0.12 是在「反馈听得见」与「连续走位三十步不烦人」之间取的：
 * 单条音效还会各自乘 0.35–0.9 的权重，所以最响的一瞬间也只是主增益的九成。
 * 主增益只在这一处定义 —— 想整体调轻 / 调响，改这一个数。
 */
const MASTER_GAIN = 0.12;

/** 一条单音的配方。`to` 给了就做滑音，`delay` 用于琶音错开。 */
interface ToneSpec {
  type: OscillatorType;
  from: number;
  to?: number;
  duration: number;
  /** 相对主增益的权重（0–1）。 */
  gain?: number;
  /** 相对「现在」的延迟秒数。 */
  delay?: number;
}

export function createSound(muted: boolean): SoundHandle {
  let mutedFlag = muted;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  /** move 的两个音高交替，避免同一音连续响成蜂鸣。 */
  let highFlip = false;
  /** 白噪声源复用一个 1 秒缓冲：滑行一次只播它的一段，省掉每次现算。 */
  let noise: AudioBuffer | null = null;

  /** 取（必要时创建）AudioContext，并把被挂起的它唤醒。任何失败都返回 null。 */
  function audio(): AudioContext | null {
    try {
      if (typeof window === 'undefined') return null;
      if (!ctx) {
        const Ctor =
          window.AudioContext ??
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(ctx.destination);
      }
      // resume 是异步的：不 await，也不让它冒 unhandled rejection。
      // 紧接着排程的音在 resume 完成后照样会响，不需要等它。
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return ctx;
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }

  /** 断开节点：声音放完后不占着图，长会话里不能留一地 garbage。 */
  function release(...nodes: AudioNode[]): void {
    try {
      for (const node of nodes) node.disconnect();
    } catch {
      /* 已经断开的节点再断一次会抛，忽略 */
    }
  }

  function tone(spec: ToneSpec): void {
    if (mutedFlag) return;
    const ac = audio();
    if (!ac || !master) return;
    try {
      const t0 = ac.currentTime + (spec.delay ?? 0);
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(spec.from, t0);
      if (spec.to !== undefined && spec.to !== spec.from) {
        // 指数滑音的终点必须 > 0，否则 WebAudio 直接抛。
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.duration);
      }
      const peak = Math.max(0.0001, spec.gain ?? 0.6);
      // 4ms 起音 + 全程指数衰减：短音不「啪」一下，也不会拖尾成噪音。
      const attack = Math.min(0.012, spec.duration * 0.3);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.duration);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + spec.duration + 0.02);
      osc.onended = () => release(osc, gain);
    } catch {
      /* 静默失败 */
    }
  }

  function noiseBuffer(ac: AudioContext): AudioBuffer {
    if (!noise) {
      const frames = Math.floor(ac.sampleRate);
      noise = ac.createBuffer(1, frames, ac.sampleRate);
      const channel = noise.getChannelData(0);
      for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  return {
    /** 走一格：40ms 正弦 blip，1200 / 1500Hz 交替。整局最常响的声音，必须最轻。 */
    move(): void {
      tone({ type: 'sine', from: highFlip ? 1500 : 1200, duration: 0.04, gain: 0.55 });
      highFlip = !highFlip;
    },

    /** 推石头：低一档的三角波闷响，带一点下滑，听起来「有重量」。 */
    push(): void {
      tone({ type: 'triangle', from: 210, to: 130, duration: 0.11, gain: 0.85 });
    },

    /** 走不动：短促下行钝音。刻意不用方波 / 高音 —— 那会变成「报错音」，很刺耳。 */
    blocked(): void {
      tone({ type: 'triangle', from: 300, to: 165, duration: 0.13, gain: 0.5 });
    },

    /** 冰面滑行：带通噪声的气声，中心频率随滑行上扬；时长随格数增长（1 格约 155ms）。 */
    slide(tiles: number): void {
      if (mutedFlag) return;
      const ac = audio();
      if (!ac || !master) return;
      try {
        const count = Number.isFinite(tiles) ? Math.min(8, Math.max(1, Math.round(tiles))) : 1;
        const duration = 0.1 + count * 0.055;
        const t0 = ac.currentTime;
        const source = ac.createBufferSource();
        source.buffer = noiseBuffer(ac);
        const band = ac.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = 1.4;
        band.frequency.setValueAtTime(700, t0);
        band.frequency.exponentialRampToValueAtTime(2400, t0 + duration);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.45, t0 + Math.min(0.04, duration * 0.3));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        source.connect(band);
        band.connect(gain);
        gain.connect(master);
        source.start(t0);
        source.stop(t0 + duration + 0.02);
        source.onended = () => release(source, band, gain);
      } catch {
        /* 静默失败 */
      }
    },

    /** 通关：C 大调四音上行琶音；最后一关再多收一个高音，作为「全部通关」的听觉句号。 */
    solve(isLast: boolean): void {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        tone({ type: 'sine', from: freq, duration: 0.24, gain: 0.55, delay: i * 0.085 });
      });
      if (isLast) {
        tone({ type: 'sine', from: 1318.51, duration: 0.34, gain: 0.4, delay: notes.length * 0.085 });
      }
    },

    /** 撤销：move 那对音高的反向（1500 → 1200），听感上像把上一步退回去。 */
    undo(): void {
      tone({ type: 'sine', from: 1500, duration: 0.035, gain: 0.4 });
      tone({ type: 'sine', from: 1200, duration: 0.045, gain: 0.4, delay: 0.05 });
    },

    /** 界面点击：极轻的一下，别盖住真正的操作音。 */
    ui(): void {
      tone({ type: 'sine', from: 880, duration: 0.022, gain: 0.3 });
    },

    /** 只改标志：已经在排程里的声音自然收尾，不强行掐断（掐断会「咔」一声）。 */
    setMuted(next: boolean): void {
      mutedFlag = next;
    },
  };
}
