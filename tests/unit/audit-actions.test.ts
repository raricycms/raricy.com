// audit-actions.ts —— 动作词汇表的纯函数单测。
//
// 【为什么这块值得单独钉】
//  1. **表必须穷尽 20 个码**：漏一条的后果是那一类在界面上退回英文机器码、
//     或在筛选下拉里选不到 —— 都静默。tsc 已经拦（`Record<AuditAction, …>`），
//     这里再钉一遍「四张表条目数都等于 AUDIT_ACTIONS 长度」，防的是把某张表
//     写成别的形状（如 `Record<string, …>` 却仍能编译过）。
//  2. **`formatActionDetail` 是白名单 switch，不是通用渲染器**：最要紧的一条用例是
//     「extra 里塞了多余的值，它**不**被显示出来」—— 这是将来写入方往 metadata 里
//     误塞敏感串（密码 / 邮箱）时唯一的护栏。
//  3. **`parseAction` 的「非法 → null」是筛选读口的语义**：非法值必须退回「不筛」，
//     而不是被判成某个默认档（那会让「按不存在的类型筛」静默变成「按 X 筛」）。

import { describe, it, expect } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABEL,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_KIND,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_LABEL,
  PUBLIC_AUDIT_ACTIONS,
  PUBLIC_AUDIT_OBJECT_TYPES,
  actionLabel,
  actionKind,
  actionGroup,
  objectTypeLabel,
  parseAction,
  formatActionDetail,
} from '@/lib/audit-actions';

describe('AUDIT_ACTIONS 词汇表', () => {
  it('20 个码，且互不重复', () => {
    expect(AUDIT_ACTIONS).toHaveLength(20);
    expect(new Set(AUDIT_ACTIONS).size).toBe(20);
  });

  it('四张 Record 表都穷尽全部动作码', () => {
    for (const table of [AUDIT_ACTION_LABEL, AUDIT_ACTION_GROUP, AUDIT_ACTION_KIND]) {
      expect(Object.keys(table).sort()).toEqual([...AUDIT_ACTIONS].sort());
    }
  });

  it('对象类型表穷尽 AUDIT_OBJECT_TYPES', () => {
    expect(Object.keys(AUDIT_OBJECT_TYPE_LABEL).sort()).toEqual([...AUDIT_OBJECT_TYPES].sort());
  });

  it('公开页的动作清单只滤掉两个 CLI-only 码', () => {
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('frame_grant');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('frame_revoke');
    expect(PUBLIC_AUDIT_ACTIONS).toHaveLength(18);
    // 其余一个不少 —— 别把「滤掉 CLI-only」写成「只剩几种」。
    expect(AUDIT_ACTIONS.filter((a) => !PUBLIC_AUDIT_ACTIONS.includes(a))).toEqual([
      'frame_grant',
      'frame_revoke',
    ]);
  });

  it('公开页的对象类型清单只滤掉 user_frame', () => {
    expect(PUBLIC_AUDIT_OBJECT_TYPES).not.toContain('user_frame');
    expect(PUBLIC_AUDIT_OBJECT_TYPES).toHaveLength(9);
  });
});

describe('parseAction：白名单解析', () => {
  it('白名单内 → 原值', () => {
    expect(parseAction('ban_user')).toBe('ban_user');
    expect(parseAction('frame_revoke')).toBe('frame_revoke');
  });

  it('非法 / 空 / 非字符串 → null（不静默给默认档）', () => {
    for (const bad of ['', '  ', 'PULBIC', 'delete_category', 123, null, undefined, {}]) {
      expect(parseAction(bad)).toBeNull();
    }
  });
});

describe('宽松展示查找', () => {
  it('已知码给中文，未知码给 null / 中性档', () => {
    expect(actionLabel('ban_user')).toBe('禁言用户');
    expect(actionLabel('nope')).toBeNull();
    expect(actionKind('ban_user')).toBe('punish');
    expect(actionKind('nope')).toBe('system');
    expect(actionGroup('delete_blog')).toBe('content');
    expect(actionGroup('nope')).toBe('system');
  });

  it('对象类型的已知/未知', () => {
    expect(objectTypeLabel('clipboard')).toBe('剪贴板');
    expect(objectTypeLabel('nope')).toBeNull();
  });
});

describe('formatActionDetail：metadata 说法', () => {
  it('change_role：from → to', () => {
    expect(formatActionDetail('change_role', { from: 'core', to: 'admin' })).toBe('core → admin');
    expect(formatActionDetail('change_role', { from: 'core' })).toBeNull();
    expect(formatActionDetail('change_role', {})).toBeNull();
  });

  it('ban_user：优先小时数，缺了才用到期时间', () => {
    expect(formatActionDetail('ban_user', { hours: 24 })).toBe('禁言 24 小时');
    expect(
      formatActionDetail('ban_user', { ban_until: '2026-10-05T12:34:56.000Z', hours: null })
    ).toBe('禁言至 2026-10-05 12:34:56');
    expect(formatActionDetail('ban_user', {})).toBeNull();
  });

  it('reset_password：只说「是不是生成的」，且**绝不**泄露 extra 里的其它键', () => {
    expect(formatActionDetail('reset_password', { generated: true })).toBe('已生成随机密码');
    expect(formatActionDetail('reset_password', { generated: false })).toBe('已重置密码');
    expect(formatActionDetail('reset_password', {})).toBe('已重置密码');
    // ★ 护栏：将来某个写入方误把密码塞进 extra，这里必须当没看见。
    const leaked = formatActionDetail('reset_password', {
      generated: false,
      password: 'hunter2',
      email: 'a@b.c',
    });
    expect(leaked).toBe('已重置密码');
    expect(leaked).not.toContain('hunter2');
    expect(leaked).not.toContain('a@b.c');
  });

  it('create_user：角色，合成邮箱加注', () => {
    expect(formatActionDetail('create_user', { role: 'core' })).toBe('创建为 core');
    expect(formatActionDetail('create_user', { role: 'core', email_synthesized: true })).toBe(
      '创建为 core（合成邮箱）'
    );
    expect(formatActionDetail('create_user', {})).toBeNull();
  });

  it('decide_appeal：申诉 #id · 结果', () => {
    expect(formatActionDetail('decide_appeal', { appeal_id: 7, result: 'accepted' })).toBe(
      '申诉 #7 · 已通过'
    );
    expect(formatActionDetail('decide_appeal', { appeal_id: 7, result: 'rejected' })).toBe(
      '申诉 #7 · 已驳回'
    );
    expect(formatActionDetail('decide_appeal', { result: 'accepted' })).toBeNull();
  });

  it('评论：指向所属文章（长 id 截短）', () => {
    expect(
      formatActionDetail('delete_comment', { blog_id: 'abcdefgh-1234-5678-90ab-cdef01234567' })
    ).toBe('文章 abcdefgh…');
    expect(formatActionDetail('restore_comment', { blog_id: 'short' })).toBe('文章 short');
    expect(formatActionDetail('delete_comment', {})).toBeNull();
  });

  it('讨论消息：指向所属频道', () => {
    expect(formatActionDetail('delete_chat_message', { channel_id: 'chan-abcdefghijkl' })).toBe(
      '频道 chan-abc…'
    );
  });

  it('文章：只有历史行才带标题', () => {
    expect(formatActionDetail('delete_blog', { blog_title: '旧文' })).toBe('《旧文》');
    expect(formatActionDetail('delete_blog', {})).toBeNull();
  });

  it('头像框：发放说到期，收回说结果', () => {
    expect(formatActionDetail('frame_grant', { expires_at: '2026-11-01T00:00:00.000Z' })).toBe(
      '到期 2026-11-01 00:00:00'
    );
    expect(formatActionDetail('frame_grant', { expires_at: null })).toBe('永久持有');
    expect(formatActionDetail('frame_revoke', { revoked: false })).toBe('空操作（本来就没持有）');
    expect(formatActionDetail('frame_revoke', { revoked: true, unequipped: true })).toBe(
      '已收回并摘下'
    );
    expect(formatActionDetail('frame_revoke', { revoked: true })).toBe('已收回');
  });

  it('未知码 / 无法解析的时间 → null', () => {
    expect(formatActionDetail('delete_clip', { anything: 'x' })).toBeNull();
    expect(formatActionDetail('ban_user', { ban_until: 'not-a-date' })).toBeNull();
  });
});
