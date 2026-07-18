import SpeedGame from '@/app/components/SpeedGame';

export const metadata = {
  title: '速度接龙 · 聪明山',
};

// 速度接龙为沉浸式全屏布局（含返回链接与操作面板），故外壳仅挂载组件本体。
export default function SpeedPage() {
  return <SpeedGame />;
}
