import Atamas from '@/app/components/Atamas/Atamas';

export const metadata = {
  title: 'ATÅMAS · 聪明山',
};

export default function AtamasPage() {
  // Atamas 组件自渲染完整页面（.game-atamas-page 深色背景 + 返回链接 + 顶部标题条），
  // 不能再包 GamePageShell，否则会双重页面壳、双重返回链接并触发 flex 横排。
  return <Atamas />;
}
