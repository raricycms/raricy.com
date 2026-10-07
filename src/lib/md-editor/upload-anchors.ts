// ─────────────────────────────────────────────────────────────────────────────
// md-editor/upload-anchors.ts —— 上传的**锚点状态**：位置随事务映射、按选择顺序落位
//
// 【它解决什么】上传是异步的，而文档在等待期间还会被用户继续编辑。两条硬要求：
//   · 图片要插在**当初那个位置**（用户打了半天字，图不能跑到文末去）；
//   · 一次选 3 张时，版面顺序必须是**用户选择的顺序**，不是网络完成的顺序
//     —— 否则「先传完的小图插到前面」会让每次结果都不一样。
//
// 【为什么锚点状态不写进正文】占位符若以文本形式落在文档里，保存时就会把
// 「上传中…」写进库（§4.3 明确禁止）。所以锚点是一个**零宽 widget 装饰**：
// 文档里没有任何字符，只有编辑视图上多出一枚小徽标。正文只在成功那一刻被改写，
// 写进去的就是最终 Markdown。
//
// 【顺序是怎么保证的】一个批次（batch）持有起点 `pos` 与按选择顺序排列的槽位。
// 第 i 个槽完成时插入到 `pos + Σ(已完成的、序号更小的槽的正文长度)`。于是：
//   · 2 号先完成 → 落在 pos；
//   · 0 号随后完成 → 落在 pos（挤到 2 号前面），版面得 [0][2]；
//   · 1 号最后完成 → 落在 pos + len(0)，正好夹在中间，版面得 [0][1][2]。
// 三条路径合起来就是选择顺序，与完成先后无关。
//
// 【pos 为什么要按「贴左侧」映射】`changes.mapPos(pos, -1)`：本批次自己插入的
// 正文正好落在 pos 上时，pos 停在插入内容的**前面**。若用默认的贴右映射，pos 会
// 被自己的插入推着往后走，第 0 槽的偏移就永远算不对（后一张会插到前一张之后，
// 顺序恰好反了，而且只在多选时看得出来）。
// ─────────────────────────────────────────────────────────────────────────────

import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

/** 一个槽位的状态。`done` 之外的都插入 0 字符，只影响徽标文案。 */
export interface UploadSlot {
  /** 批次内唯一（= 文件名 + 序号，同名文件也能分开）。 */
  key: string;
  /** 展示用文件名。 */
  name: string;
  status: 'pending' | 'done' | 'failed';
  /** 已插入正文的长度 —— 只对 status==='done' 有意义。 */
  length: number;
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

/** 某个槽位有结果了（成功 = length 为插入正文长度；失败 = length 0）。 */
export const settleUploadSlot = StateEffect.define<{
  batchId: number;
  key: string;
  length: number;
  message?: string;
}>();

/** 取消整批（点徽标上的 ×）。 */
export const cancelUploadBatch = StateEffect.define<number>();

/** 全部槽位都有结果（或整批取消）后，批次就该从状态里退场。 */
function isSettled(b: UploadBatch): boolean {
  return b.cancelled || b.slots.every((s) => s.status !== 'pending');
}

function mapBatch(batch: UploadBatch, changes: { mapPos: (pos: number, assoc?: number) => number }) {
  return { ...batch, pos: changes.mapPos(batch.pos, -1) };
}

export const uploadBatchField = StateField.define<UploadBatch[]>({
  create: () => [],
  update(batches, tr) {
    let next = batches.map((b) => mapBatch(b, tr.changes));
    for (const effect of tr.effects) {
      if (effect.is(addUploadBatch)) {
        next = [
          ...next,
          {
            id: effect.value.id,
            pos: Math.max(0, Math.min(effect.value.pos, tr.newDoc.length)),
            slots: effect.value.names.map((name, i) => ({
              key: `${effect.value.id}:${i}`,
              name,
              status: 'pending' as const,
              length: 0,
            })),
            cancelled: false,
          },
        ];
      } else if (effect.is(settleUploadSlot)) {
        const { batchId, key, length, message } = effect.value;
        next = next.map((b) =>
          b.id !== batchId
            ? b
            : {
                ...b,
                slots: b.slots.map((s) =>
                  s.key !== key
                    ? s
                    : { ...s, status: message ? 'failed' : 'done', length, message }
                ),
              }
        );
      } else if (effect.is(cancelUploadBatch)) {
        next = next.map((b) => (b.id === effect.value ? { ...b, cancelled: true } : b));
      }
      next = next.filter((b) => !isSettled(b));
    }
    return next;
  },
});

/**
 * 第 `slotIndex` 个槽该插到哪 —— 见文件头的三步推导。
 * 批次不存在（已被取消并退场）时返回 null，调用方据此**放弃插入**。
 */
export function batchInsertPos(state: EditorState, batchId: number, slotIndex: number): number | null {
  const batch = state.field(uploadBatchField, false)?.find((b) => b.id === batchId);
  if (!batch || batch.cancelled) return null;
  let offset = 0;
  for (let i = 0; i < slotIndex && i < batch.slots.length; i += 1) offset += batch.slots[i].length;
  return Math.max(0, Math.min(batch.pos + offset, state.doc.length));
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
