import { describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { createInsertAnchor } from '@/lib/md-editor/insert-anchor';

// 资源面板的落点映射。
//
// 【为什么值得单测】这一层全是「错了不报错」的：面板打开期间正文一变（在飞的上传
// 落地、用户按撤销），落点若不跟着走，引用会插到别处 —— 页面上只是一段位置不对的
// 文字，没有任何异常。三种相对位置（改动在落点之前 / 正上方 / 之后）必须分开验。

/** 造一个「把 [from,to) 换成 insert」的改动描述。 */
function changes(doc: string, from: number, to: number, insert: string) {
  return ChangeSet.of({ from, to, insert }, doc.length);
}

describe('insert-anchor：在编辑期间活下来', () => {
  it('没捕获过时 get() 是 null（面板没开就不该有落点）', () => {
    const anchor = createInsertAnchor();
    expect(anchor.get()).toBeNull();
    anchor.map(changes('abcdef', 0, 0, 'X'));
    expect(anchor.get()).toBeNull();
  });

  it('改动落在落点之前 → 落点整体右移', () => {
    const anchor = createInsertAnchor();
    anchor.capture(4);
    // 在开头插 3 个字符
    anchor.map(changes('abcdef', 0, 0, 'XYZ'));
    expect(anchor.get()).toBe(7);
  });

  it('改动落在落点之后 → 落点不动', () => {
    const anchor = createInsertAnchor();
    anchor.capture(2);
    anchor.map(changes('abcdef', 5, 5, 'XYZ'));
    expect(anchor.get()).toBe(2);
  });

  it('★ 改动正好落在落点上 → 落点让到插入内容之后 ★', () => {
    // 这正是「面板开着的时候一张图传完了」的样子：上传在光标处插一行图片。
    // 让到后面（assoc: 1）之后，用户在面板里挑的引用排在图片后面 —— 与
    // 「先看到刚传上来的图，再插引用」的直觉一致；让到前面就会插在图片之前。
    const anchor = createInsertAnchor();
    anchor.capture(3);
    anchor.map(changes('abcdef', 3, 3, '![图](/x)\n'));
    expect(anchor.get()).toBe(3 + '![图](/x)\n'.length);
  });

  it('落点被整段删掉 → 钳到删除处，不会跑到文档外面', () => {
    const anchor = createInsertAnchor();
    anchor.capture(4);
    anchor.map(changes('abcdef', 2, 5, ''));
    expect(anchor.get()).toBe(2);
  });

  it('clear() 之后不再映射（面板取消 = 这次插入作废）', () => {
    const anchor = createInsertAnchor();
    anchor.capture(2);
    anchor.clear();
    anchor.map(changes('abcdef', 0, 0, 'XYZ'));
    expect(anchor.get()).toBeNull();
  });

  it('连续两次改动累积映射（不是各自按原值算）', () => {
    const anchor = createInsertAnchor();
    anchor.capture(3);
    anchor.map(changes('abcdef', 0, 0, 'XX'));
    anchor.map(changes('XXabcdef', 0, 0, 'YY'));
    expect(anchor.get()).toBe(7);
  });

  it('capture() 可以重设（插入一条之后把落点交回调用方定）', () => {
    const anchor = createInsertAnchor();
    anchor.capture(3);
    anchor.map(changes('abcdef', 3, 3, 'ZZ'));
    expect(anchor.get()).toBe(5);
    anchor.capture(0);
    expect(anchor.get()).toBe(0);
  });
});
