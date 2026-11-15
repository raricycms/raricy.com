'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ProfileTheme —— 个人主页的「名片底色」状态（客户端）
//
// 【为什么需要它】身份条（.profile-hero）在服务端渲染，它的底色却要在编辑器里**立刻**
// 预览：选一下不生效、要等保存刷新才变色，手感是断的。所以把整页包进这个客户端壳，
// 壳只负责把 tone 变成根元素上的类（CSS 再去选 .profile-hero）；身份条本身仍是服务端
// 组件，壳不碰它的 DOM，也不给它单独传 props。
//
// 【初值与保存后的同步】服务端数据到达（首次渲染 / router.replace 带回新 RSC）时把
// tone 拉回服务端值；编辑器里的改动走 setTone。两者都收敛到「最后一次服务端值」，
// 所以「放弃」能回到刚保存的那一版，而不是回到更早的初值。
//
// ⚠️ 类名必须由白名单值拼出（tone 来自服务端已过 isHeroTone 的 DTO）。这里不做二次
// 校验：服务端 DTO 是唯一来源，客户端再猜一次反而会出现两个判据。
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Tone } from '@/lib/profile-blocks';

interface ProfileToneState {
  /** 当前预览值（null = 纸白）。 */
  tone: Tone | null;
  /** 服务端那一次的值：判断「有没有未保存改动」与「放弃回到哪」都拿它比。 */
  initialTone: Tone | null;
  setTone: (tone: Tone | null) => void;
}

const Ctx = createContext<ProfileToneState | null>(null);

/** 必须在 <ProfileTheme> 内使用。 */
export function useProfileTone(): ProfileToneState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useProfileTone 必须在 ProfileTheme 内使用');
  return value;
}

export default function ProfileTheme({
  initialTone,
  children,
}: {
  initialTone: Tone | null;
  children: ReactNode;
}) {
  const [tone, setTone] = useState<Tone | null>(initialTone);

  // 保存成功后 router.replace 会带回新 RSC：不同步的话，下一次进编辑再「放弃」会
  // 跳回上一次的初值（旧底色），而不是刚刚保存的那一版。
  useEffect(() => {
    setTone(initialTone);
  }, [initialTone]);

  return (
    <Ctx.Provider value={{ tone, initialTone, setTone }}>
      <div className={tone ? `profile-page profile-page--hero-tone-${tone}` : 'profile-page'}>
        {children}
      </div>
    </Ctx.Provider>
  );
}
