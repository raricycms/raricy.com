// ─────────────────────────────────────────────────────────────────────────────
// md-editor/upload-anchors.ts —— 上传的**锚点状态**：位置随事务映射、按选择顺序落位
//
// 【它解决什么】上传是异步的，而文档在等待期间还会被用户继续编辑。三条硬要求：
//   · 图片要插在**当初那个位置**（用户打了半天字，图不能跑到文末去）；
//   · 一次选 3 张时，版面顺序必须是**用户选择的顺序**，不是网络完成的顺序
//     —— 否则「先传完的小图插到前面」会让每次结果都不一样；
//   · 锚点被删掉之后，迟到的结果**不许再插回正文**（见最后一节）。
//
// 【为什么锚点状态不写进正文】占位符若以文本形式落在文档里，保存时就会把
// 「上传中…」写进库（§4.3 明确禁止）。所以锚点是一个**零宽 widget 装饰**：
// 文档里没有任何字符，只有编辑视图上多出一枚小徽标。正文只在成功那一刻被改写，
// 写进去的就是最终 Markdown。
//
// 【顺序是怎么保证的】一个批次（batch）持有起点 `pos` 与按选择顺序排列的槽位。
// 第 i 个槽插入到 `max(pos, 序号更小的、已完成的那些槽的 to)`。于是：
//   · 2 号先完成 → 落在 pos；
//   · 0 号随后完成 → 落在 pos（挤到 2 号前面），版面得 [0][2]；
//   · 1 号最后完成 → 落在 0 号的 to 之后，正好夹在中间，版面得 [0][1][2]。
// 三条路径合起来就是选择顺序，与完成先后无关。
//
// 【槽位记的是区间，不是长度】插入之后用户还能改那张图：把 `![A](/a)` 的 alt
// 补成 `![LONGCAPTIONA](/a)`、选中半张删掉、再撤销回来。**固定长度**只记住
// 「当时插了几个字符」，编辑之后就不再等于那段正文的真实跨度 —— 第二张图会落进
// 第一张的 alt / URL 里（`![LONGCAP![B](/b)TIONA](/a)`），而页面上看不出异常。
// 所以每个槽记的是自己那段正文的**区间** `[from, to)`，随每个事务映射（见 mapSlot）。
//
// 【pos 为什么要按「贴左侧」映射】`changes.mapPos(pos, -1)`：本批次自己插入的
// 正文正好落在 pos 上时，pos 停在插入内容的**前面**。若用默认的贴右映射，pos 会
// 被自己的插入推着往后走，第 0 槽的偏移就永远算不对（后一张会插到前一张之后，
// 顺序恰好反了，而且只在多选时看得出来）。
//
// 【锚点被删 = 整批退场】上传期间用户把锚点那一段删了（最典型：全选删除、清空
// 正文），迟到的那张图**不该重新写回正文**：用户刚亲手把这段内容清掉，再凭空长出
// 一张图，他只能再删一次。判据见 isAnchorGone —— 锚点左右**两个字符都被这次改动
// 删掉**（文档边界算「本来就没有那一侧」）。于是：
//   · 只删掉锚点一侧的文字 → 锚点还在，照旧插在那儿（不误伤）；
//   · 正常打字、插别的图（都是插入）→ 一律不误伤；
//   · 空文档里上传 → 根本没有删除动作，不误伤。
// 退场就是**从状态里去掉**（与用户点 × 取消同一条路），组件那边 `batchInsertPos`
// 拿到 null 便放弃插入。⚠️ 放弃的是**这一次插入**，不是去删已经传上去的素材 ——
// 图床里的东西照旧留着，不靠删素材来补偿一次编辑（同 upload.ts 的口径）。
// 另注：**撤销不会让退场的批次回来**（它已经不在状态里了），正文恢复之后那几张图
// 仍然不会自己长出来 —— 这是刻意的：一批上传只对它出发时那份正文负责。
// ─────────────────────────────────────────────────────────────────────────────

import { StateEffect, StateField } from '@codemirror/state';
import type { ChangeDesc, EditorState, Extension, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

/** 一个槽位的状态。`done` 之外的都不占正文，只影响徽标文案。 */
export interface UploadSlot {
  /** 批次内唯一（= 文件名 + 序号，同名文件也能分开）。 */
  key: string;
  /** 展示用文件名。 */
  name: string;
  status: 'pending' | 'done' | 'failed';
  /**
   * 这个槽插进正文的那一段**区间** `[from, to)`（按当前位置，随事务映射）。
   * · done：插入成功后有内容，`from < to`；内容被用户删掉之后会塌成 `from === to`；
   * · pending / failed：`from === to`，不占正文，只是个「该插哪儿」的点。
   */
  from: number;
  to: number;
  /** 失败原因（徽标 tooltip）。 */
  message?: string;
}

export interface UploadBatch {
  id: number;
  /** 批次起点；随每次事务映射（见文件头）。 */
  pos: number;
  slots: UploadSlot[];
  /** 用户已取消 —— 组件据此丢弃迟到的响应。 */
  cancelled: boolean;
}

/** 新建一个批次（用户在某个位置选了 N 个文件）。 */
export const addUploadBatch = StateEffect.define<{
  id: number;
  pos: number;
  names: string[];
}>();

/**
 * 某个槽位有结果了。`message` 有值 = 失败（那时正文一个字符都没动，区间退化成点）。
 *
 * **刻意不带「插入长度」**：这一段正文的区间由本事务里**真实发生的那条改动**映射
 * 出来（调用方插了多少、插在哪儿，事务里写着）。再报一个长度进来只会多出一份
 * 说法，两份一旦不一致就是静默的（见文件头「槽位记的是区间」）。
 */
export const settleUploadSlot = StateEffect.define<{
  batchId: number;
  key: string;
  message?: string;
}>();

/** 取消整批（点徽标上的 ×）。 */
export const cancelUploadBatch = StateEffect.define<number>();

/** 全部槽位都有结果（或整批取消）后，批次就该从状态里退场。 */
function isSettled(b: UploadBatch): boolean {
  return b.cancelled || b.slots.every((s) => s.status !== 'pending');
}

/**
 * 这次改动把锚点**整个抹掉**了吗 —— 判据是「左右两个邻居字符都没了」。
 *
 * 【为什么不是「删除区间盖住了锚点」】那个判据太宽：`HEAD|TAIL` 里删掉锚点右侧
 * 那段（`[pos, 文末)`）也「盖住」了锚点，可它明明还在（左边有字、光标就在文档
 * 末尾）—— 这时放弃上传纯属误伤。反过来，「锚点恰好在删除区间的边界上」又太窄：
 * 全选删除时锚点要么在起点、要么在终点，边界判据一个都抓不到，而全选删除正是最
 * 常见的场景（也是本次修复要堵的那一个）。
 *
 * 于是判据落在**邻居**上：锚点左边那个字符（下标 `pos - 1`）与右边那个字符
 * （下标 `pos`）**都在这一次改动里被删掉** ⇒ 锚点没有依托了。文档边界算「本来
 * 就没有那一侧」，所以空文档里上传不会被误判。只在**确实发生了删除**时才判 ——
 * 纯插入（打字、插别的图）一律不碰。
 */
function isAnchorGone(tr: Transaction, pos: number): boolean {
  let leftGone = pos <= 0; // 左边本来就没有字符
  let rightGone = pos >= tr.startState.doc.length; // 右边本来就没有字符
  let deleted = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (toA <= fromA) return; // 纯插入
    deleted = true;
    if (fromA < pos && pos <= toA) leftGone = true; // 下标 pos-1 落在被删区间里
    if (fromA <= pos && pos < toA) rightGone = true; // 下标 pos 落在被删区间里
  });
  return deleted && leftGone && rightGone;
}

/**
 * 把一个槽位的区间按这次改动映射过去。
 *
 * **from 贴右（assoc 1）、to 贴左（assoc -1）**：正好落在区间两端插入的文字不算
 * 这段内容的一部分（在开头打字 → 整段跟着右移；在结尾打字 → 区间不动），而在区间
 * **内部**改多长，区间就跟着变多长 —— 第二张图因此永远落在第一张的后面。
 *
 * 零宽（未完成 / 已失败 / 内容被删光）的槽位两边取同一个方向：否则「在它那个点上
 * 插一段」会把 from 推到 to 的右边，得到一个负区间，下一个命令直接抛
 * `Invalid change range`。
 */
function mapSlot(slot: UploadSlot, changes: ChangeDesc): UploadSlot {
  if (slot.to <= slot.from) {
    const at = changes.mapPos(slot.from, -1);
    return { ...slot, from: at, to: at };
  }
  return { ...slot, from: changes.mapPos(slot.from, 1), to: changes.mapPos(slot.to, -1) };
}

/** 批次随事务映射。返回 null = 锚点被这次改动抹掉了 → 整批退场（见文件头）。 */
function mapBatch(batch: UploadBatch, tr: Transaction): UploadBatch | null {
  if (isAnchorGone(tr, batch.pos)) return null;
  return {
    ...batch,
    pos: tr.changes.mapPos(batch.pos, -1),
    slots: batch.slots.map((s) => mapSlot(s, tr.changes)),
  };
}

/**
 * 第 `slotIndex` 个槽该插到哪（**旧坐标**，配 `docLength` 收口）。
 *
 * 组件（`batchInsertPos`，拿当前 state）与状态机（结算时把插入点映射成区间）
 * **共用这一个函数** —— 两处各算一份的话，「组件插在 A、状态机以为插在 B」这种
 * 错配不会报任何错，只会让图慢慢错位。
 */
function insertPosOf(batch: UploadBatch, slotIndex: number, docLength: number): number {
  let at = batch.pos;
  for (let i = 0; i < slotIndex && i < batch.slots.length; i += 1) {
    // 取「前面那些槽的右端」的最大值：已完成的是它那段正文的末尾，
    // 未完成的与 pos 相同（`from === to`）。
    at = Math.max(at, batch.slots[i].to);
  }
  return Math.max(0, Math.min(at, docLength));
}

export const uploadBatchField = StateField.define<UploadBatch[]>({
  create: () => [],
  update(batches, tr) {
    // ① 先按本次事务映射（含「锚点被删 → 整批退场」）。被抹掉的那些从这里就没了，
    //    所有临时坐标仍按**旧文档**解释（mapPos / iterChanges 都吃旧坐标）。
    const next: UploadBatch[] = [];
    for (const b of batches) {
      const mapped = mapBatch(b, tr);
      if (mapped) next.push(mapped);
    }

    // ② 再落到效果上。结算要算出「刚刚插进正文的那一段」的区间，得先拿**旧坐标**
    //    算插入点（`tr.changes.mapPos` 吃的是旧坐标），所以回溯到 `batches` 里
    //    本事务之前的那一份。
    for (const effect of tr.effects) {
      if (effect.is(addUploadBatch)) {
        const pos = Math.max(0, Math.min(effect.value.pos, tr.newDoc.length));
        next.push({
          id: effect.value.id,
          pos,
          slots: effect.value.names.map((name, i) => ({
            key: `${effect.value.id}:${i}`,
            name,
            status: 'pending' as const,
            from: pos,
            to: pos,
          })),
          cancelled: false,
        });
      } else if (effect.is(settleUploadSlot)) {
        const { batchId, key, message } = effect.value;
        const before = batches.find((b) => b.id === batchId);
        const index = before ? before.slots.findIndex((s) => s.key === key) : -1;
        const atOld =
          before && index >= 0 ? insertPosOf(before, index, tr.startState.doc.length) : null;
        settle(next, batchId, key, (s) => {
          if (message) return { ...s, status: 'failed' as const, message };
          // 本事务里插进去的那段正文就是它 —— 从插入点映射出区间。
          //（`atOld` 为 null 只可能是「同一个事务里先建批次、又结算它」，
          //  正常路径不会发生；那时退化成零宽点，宁可不占位置。）
          const from = atOld === null ? s.from : tr.changes.mapPos(atOld, -1);
          const to = atOld === null ? s.from : tr.changes.mapPos(atOld, 1);
          return { ...s, status: 'done' as const, from, to, message: undefined };
        });
      } else if (effect.is(cancelUploadBatch)) {
        for (let i = 0; i < next.length; i += 1) {
          if (next[i].id === effect.value) next[i] = { ...next[i], cancelled: true };
        }
      }
      // 退场要在**每个效果之后**跑（与原来一致）：批次可能因为这次结算 / 取消而结算完
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (isSettled(next[i])) next.splice(i, 1);
      }
    }
    return next;
  },
});

/** 就地替换一个批次里某个槽位的状态（key 对不上时原样不动）。 */
function settle(
  batches: UploadBatch[],
  batchId: number,
  key: string,
  patch: (slot: UploadSlot) => UploadSlot
): void {
  for (let i = 0; i < batches.length; i += 1) {
    const b = batches[i];
    if (b.id !== batchId || !b.slots.some((s) => s.key === key)) continue;
    batches[i] = { ...b, slots: b.slots.map((s) => (s.key === key ? patch(s) : s)) };
  }
}


/**
 * 第 `slotIndex` 个槽该插到哪 —— 见文件头的三步推导。
 * 批次不存在（已被取消、或**锚点已被删**而退场）时返回 null，调用方据此放弃插入。
 */
export function batchInsertPos(state: EditorState, batchId: number, slotIndex: number): number | null {
  const batch = state.field(uploadBatchField, false)?.find((b) => b.id === batchId);
  if (!batch || batch.cancelled) return null;
  return insertPosOf(batch, slotIndex, state.doc.length);
}

/** 读一个批次（组件判「还要不要接手这个响应」）。 */
export function findBatch(state: EditorState, batchId: number): UploadBatch | undefined {
  return state.field(uploadBatchField, false)?.find((b) => b.id === batchId);
}

/** 徽标：`上传中 1/3` / `2 张失败`，带一颗取消按钮（点它 = 放弃这批）。 */
class UploadChipWidget extends WidgetType {
  constructor(readonly batch: UploadBatch) {
    super();
  }

  eq(other: UploadChipWidget): boolean {
    return (
      other.batch.id === this.batch.id &&
      other.batch.cancelled === this.batch.cancelled &&
      other.batch.slots.map((s) => `${s.key}${s.status}${s.message ?? ''}`).join('|') ===
        this.batch.slots.map((s) => `${s.key}${s.status}${s.message ?? ''}`).join('|')
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    // 类名住在 SCSS 的 md-editor 段（css-tsx-classes 守卫查的是 .tsx/.ts 里的
    // 类名字面量，widget 是拼出来的 DOM，同样在扫描范围里）。
    wrap.className = 'md-upload-chip';
    const pending = this.batch.slots.filter((s) => s.status === 'pending').length;
    const failed = this.batch.slots.filter((s) => s.status === 'failed');
    const total = this.batch.slots.length;

    const label = document.createElement('span');
    label.className = 'md-upload-chip__label';
    if (pending > 0) {
      label.textContent = `上传中 ${total - pending}/${total}`;
    } else if (failed.length > 0) {
      label.textContent = `${failed.length} 张失败`;
      if (failed.length === 1 && failed[0].message) label.title = failed[0].message;
    } else {
      label.textContent = '上传完成';
    }
    wrap.appendChild(label);

    if (pending > 0) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'md-upload-chip__cancel';
      cancel.textContent = '×';
      cancel.title = '放弃这批上传';
      // 组件在编辑器 DOM 上做事件委托，读这两个属性 —— 不往 widget 里塞闭包，
      // 免得 StateField 的 eq 比较被函数引用搅乱。
      cancel.setAttribute('data-upload-cancel', String(this.batch.id));
      cancel.setAttribute('aria-label', '放弃这批上传');
      wrap.appendChild(cancel);
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    // 让点击落到 ascii 按钮上而不是被 CM6 当成「点了编辑区」
    return true;
  }
}

/**
 * 徽标装饰 —— 每个批次一枚，画在它的起点上。
 *
 * **必须自己排序**：批次在状态里的顺序是「创建顺序」，而起点位置是任意的 ——
 * 先选的往文末拖、后选的落在开头时，区间就是倒序的。`Decoration.set` 要求区间
 * 有序，倒序会直接抛 `Ranges must be added sorted`（整篇编辑器崩掉，报错在 CM6
 * 内部，看不出是这里）。同一起点上多个批次时按 id 稳定排序，免得每帧重排。
 */
export const uploadChipDecorations: Extension = EditorView.decorations.compute(
  [uploadBatchField],
  (state) =>
    Decoration.set(
      (state.field(uploadBatchField, false) ?? [])
        .map((batch) => ({
          batch,
          from: Math.max(0, Math.min(batch.pos, state.doc.length)),
        }))
        .sort((a, b) => a.from - b.from || a.batch.id - b.batch.id)
        .map(({ batch, from }) =>
          Decoration.widget({ widget: new UploadChipWidget(batch), side: 1 }).range(from)
        ),
      true
    )
);
