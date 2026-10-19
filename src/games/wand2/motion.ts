import { INPUT, SPEED, TICK_MS, type Facing, type Player, type Slime, type Snapshot } from '../../../shared/wand2/protocol';
import { move } from '../../../shared/wand2/geometry';

/**
 * 客户端运动平滑（纯计算，无 DOM / React / 计时器）。
 *
 * 服务端每 `TICK_MS`（50ms）广播一次权威快照。如果按「收到就画、在下一次快照到来前
 * 把位移插完」来做，网络抖动会原封不动地变成画面抖动：
 *   · 包早到 → 上一段还没插完就被换上新的起点，画面**前跳**几像素；
 *   · 包迟到 → 进度早已到 1，人物**定住**几十毫秒，然后才继续。
 * 在 20Hz 的刷新率下这两种都肉眼可见，移动时就是「画面不连贯」。
 *
 * 这里的做法是**往回退一点再画**，把抖动吸收在缓冲里：
 *   1. 保留最近若干个快照，按**到达时刻**插值，渲染时刻固定落后 `now` 一个缓冲
 *      （`INTERP_DELAY_MS`）。包早到／迟到都不会改变正在播的那一段，只会改变缓冲的消费速度；
 *   2. 缓冲被吃穿（包迟到超过缓冲）时用最后两个快照的速度**外推**，最多
 *      `EXTRAPOLATE_MS`，到上限后停住而不是无限飘；
 *   3. 自己那一格额外补上「播放缓冲」这一段（`leadOwn`）：别人看到的是被缓冲拖慢的画面，
 *      自己操作的那一格不该也跟着慢半个来回 —— 以这一帧的权威位置为锚点，按**最近一个
 *      缓冲里的本地按键历史**逐步走、用同一份 `move()` 判碰撞，把位置推到 `now`。
 *      关键是「按键历史」而不是「当前按键」：拿当前按键去补整段缓冲，按下的一瞬间就会把
 *      整整一个缓冲的位移一次加上（150px/s × 100ms = 15px 的瞬移），松开再整段扣回来
 *      （先退一截、之后画面上还在继续走）。位移本来是在这 100ms 里逐渐发生的，按历史
 *      积分才会连续：按下当帧只补那几毫秒，松手当帧补到松开那一刻为止。朝向与走路标记也
 *      在同一步按按键更新，免得位置已经开始走了、精灵还站着不动。
 *
 * 只影响「播放」：不修改服务端权威状态，也不预测其他玩家。外推用最后两帧的真实速度，
 * 不是凭空猜；上限之后停住，所以掉线/长卡顿时画面会停在最后位置而不是越飘越远。
 */

/** 播放缓冲：画 `now - INTERP_DELAY_MS` 那一刻的世界。两个 tick 足以吃掉常见抖动。 */
export const INTERP_DELAY_MS = TICK_MS * 2;
/** 缓冲被吃穿后最多外推这么久；超过就停在最后位置，避免转角处飘进墙里。 */
export const EXTRAPOLATE_MS = TICK_MS * 2;
/** 只留最近这么多个快照，够插值 + 外推即可，别把连接开一晚上攒成内存泄漏。 */
export const MAX_SAMPLES = 8;

interface Sample {
  snapshot: Snapshot;
  at: number;
}

/** 本地按键状态变化；`at` 是这个状态开始生效的采样时刻。 */
interface ButtonFrame {
  at: number;
  buttons: number;
}

/** 某一帧该画的世界：位置已经平滑，其余字段取插值区间起点那一刻的权威状态。 */
export interface Scene {
  players: Player[];
  slimes: Slime[];
  /** 画面这一刻的场景时钟（= 真实 now - 播放缓冲）。动画节拍与剩余毫秒都按它算。 */
  time: number;
  /** 插值区间起点样本的到达时刻（`time - at` 即这段状态已过去的毫秒数）。 */
  at: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** 线性查找：一屏最多 32 人 + 28 只史莱姆，Map 的建表开销比多扫几眼更贵。 */
function find<T extends { id: string | number }>(list: T[], id: string | number): T | undefined {
  for (const entry of list) if (entry.id === id) return entry;
  return undefined;
}

export class Motion {
  private samples: Sample[] = [];
  /** 最近一个缓冲内的按键变化，用来把自己那格从权威位置连续地推到 `now`。 */
  private frames: ButtonFrame[] = [];
  private lastNow: number | null = null;
  private lastButtons = 0;

  /** 收下一帧权威快照。`at` 是**到达时刻**（`performance.now()`），同一条连接上单调递增。 */
  push(snapshot: Snapshot, at: number) {
    this.samples.push({ snapshot, at });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  /** 断开 / 重连时清空：缓冲里是上一条连接的世界，混进新连接会画出鬼影。 */
  clear() {
    this.samples = [];
    this.frames = [];
    this.lastNow = null;
    this.lastButtons = 0;
  }

  get size() {
    return this.samples.length;
  }

  /**
   * 生成这一帧要画的世界。
   *
   * @param now     本轮渲染的真实时刻（rAF 时间戳，与 `push` 的 `at` 同一时钟）
   * @param ownId   自己那格连接 id；空串表示还不知道自己是谁
   * @param buttons 当前按键位（`INPUT` 的按位或），用于本地向前推
   */
  sample(now: number, ownId: string, buttons: number): Scene | null {
    this.trackInput(now, buttons);
    const samples = this.samples;
    if (!samples.length) return null;
    const time = now - INTERP_DELAY_MS;
    // 找 time 落在的区间 [a, b)。从新到旧扫，正常只有 1~2 次比较。
    let index = samples.length - 1;
    while (index > 0 && samples[index].at > time) index--;
    const a = samples[index];
    const b = samples[index + 1];
    // 缓冲吃穿：time 已经越过最新样本。用最后一个样本相对上一个样本的速度外推，
    // 最多 EXTRAPOLATE_MS；只有一个样本（刚连上）时没有速度可用，直接停住。
    const starved = !b;
    const ahead = starved ? Math.min(Math.max(0, time - a.at), EXTRAPOLATE_MS) : 0;
    const previous = index > 0 ? samples[index - 1] : null;
    const span = previous ? a.at - previous.at : 0;
    const velocity = (id: string | number) => {
      if (!previous || span <= 0) return { x: 0, y: 0 };
      const old = find(previous.snapshot.players, id) ?? find(previous.snapshot.slimes, id);
      const current = find(a.snapshot.players, id) ?? find(a.snapshot.slimes, id);
      if (!old || !current) return { x: 0, y: 0 };
      return { x: (current.x - old.x) / span, y: (current.y - old.y) / span };
    };
    const t = b ? clamp01((time - a.at) / Math.max(1, b.at - a.at)) : 1;

    // 实体集合取**较新**的那一帧：中途加入的按新帧状态直接出现，离开的立刻消失，
    // 不会因为「旧帧里还有」而多画一个 tick。
    const players = (b ? b.snapshot.players : a.snapshot.players).map((next): Player => {
      const old = find(a.snapshot.players, next.id);
      if (old && b) return { ...old, x: lerp(old.x, next.x, t), y: lerp(old.y, next.y, t) };
      if (starved && ahead > 0) { const v = velocity(next.id); return { ...next, x: next.x + v.x * ahead, y: next.y + v.y * ahead }; }
      return next;
    });
    const slimes = (b ? b.snapshot.slimes : a.snapshot.slimes).map((next): Slime => {
      const old = find(a.snapshot.slimes, next.id);
      if (old && b) return { ...old, x: lerp(old.x, next.x, t), y: lerp(old.y, next.y, t) };
      if (starved && ahead > 0) { const v = velocity(next.id); return { ...next, x: next.x + v.x * ahead, y: next.y + v.y * ahead }; }
      return next;
    });

    // 自己那格向前推：权威位置只到 time 为止，而玩家看到的是 now —— 这中间的
    // INTERP_DELAY_MS 用这段时间里的本地按键补上，操作才有「跟手」的感觉。
    if (ownId) {
      const own = find(players, ownId);
      if (own) this.leadOwn(own, time, a.at, now);
    }
    return { players, slimes, time, at: a.at };
  }

  /**
   * 记下按键状态的变化。
   *
   * 变化边界记在**上一次采样时刻**：两次 rAF 之间不知道按键具体在哪一刻按下，按「上一帧
   * 就已经按下」算 —— 代价是最多提前一帧（60fps 下 2.5px），换来按下当帧就有位移。第一次
   * 采样时把状态往前铺满一个缓冲，否则「刷新页面时正按着键」会被当成刚刚按下。
   */
  private trackInput(now: number, buttons: number) {
    if (this.lastNow === null) {
      this.lastButtons = buttons;
      this.lastNow = now;
      this.frames.push({ at: now - INTERP_DELAY_MS, buttons });
      return;
    }
    if (buttons !== this.lastButtons) {
      this.frames.push({ at: this.lastNow, buttons });
      this.lastButtons = buttons;
    }
    this.lastNow = now;
    // 只需要覆盖一个播放缓冲再加一点边界；长时间挂机别把数组攒大。
    const stale = now - INTERP_DELAY_MS - TICK_MS * 4;
    while (this.frames.length > 1 && this.frames[1].at <= stale) this.frames.shift();
  }

  /**
   * 把权威位置从 `time` 推到 `now`：按这一段的**本地按键历史**逐步走。
   *
   * 规则与服务端 `shared/wand2/world.ts` 的 step 保持一致（速度、斜向归一化、挥剑时
   * 0.4 倍、受击 650ms 内不能动，碰撞直接用同一份 `move()`）—— 各写一份的话，客户端会
   * 把自己推进服务端不认的墙里，然后每次快照都被拽回来。`attack` / `hurt` 是「剩余
   * 毫秒」，按快照时刻的值扣到当前；每一步先扣受击再判能不能走，与 step 的顺序一致。
   */
  private leadOwn(own: Player, time: number, at: number, now: number) {
    const elapsed = Math.max(0, time - at);
    let attack = Math.max(0, own.attack - elapsed);
    let hurt = Math.max(0, own.hurt - elapsed);
    let cursor = time;
    let buttons = this.frames[0]?.buttons ?? 0;
    const advance = (ms: number) => {
      if (ms <= 0) return;
      hurt = Math.max(0, hurt - ms);
      const dx = Number(!!(buttons & INPUT.right)) - Number(!!(buttons & INPUT.left));
      const dy = Number(!!(buttons & INPUT.down)) - Number(!!(buttons & INPUT.up));
      if ((dx || dy) && hurt < 650) {
        const norm = Math.hypot(dx, dy);
        const distance = ((SPEED * ms) / 1000) * (attack > 0 ? 0.4 : 1);
        move(own, (dx / norm) * distance, (dy / norm) * distance);
      }
      attack = Math.max(0, attack - ms);
    };
    for (const frame of this.frames) {
      if (frame.at <= time) { buttons = frame.buttons; continue; }
      if (frame.at >= now) break;
      advance(frame.at - cursor);
      cursor = frame.at;
      buttons = frame.buttons;
    }
    advance(now - cursor);
    // 朝向与走路标记也按本地按键立即跟上（规则同 step）：位置已经开始走了、精灵却还要等
    // 下一帧快照才切走路帧，看着像在冰面上滑。受击剩余时间用积分后的值，与服务端一致。
    const dx = Number(!!(buttons & INPUT.right)) - Number(!!(buttons & INPUT.left));
    const dy = Number(!!(buttons & INPUT.down)) - Number(!!(buttons & INPUT.up));
    if (!attack && (dx || dy)) own.facing = (Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 2 : 1 : dy > 0 ? 0 : 3) as Facing;
    own.moving = !!(dx || dy) && hurt < 650;
  }
}
