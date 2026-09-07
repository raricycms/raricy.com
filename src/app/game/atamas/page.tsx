import { cookies } from 'next/headers';
import Atamas from '@/app/components/Atamas/Atamas';
import { THEME_COOKIE, LANG_COOKIE } from '@/lib/atamas-pref';
import { TRANSLATIONS } from '@/app/components/Atamas/i18n';

export const dynamic = 'force-dynamic'; // 依赖偏好 cookie，禁用静态化

export const metadata = {
  title: 'ATÅMAS · 聪明山',
};

export default async function AtamasPage() {
  // Atamas 组件自渲染完整页面（.game-atamas-page 深色背景 + 返回链接 + 顶部标题条），
  // 不能再包 GamePageShell，否则会双重页面壳、双重返回链接并触发 flex 横排。
  const store = await cookies();
  const themePref = store.get(THEME_COOKIE)?.value;
  const langPref = store.get(LANG_COOKIE)?.value;
  // 镜像直出：theme cookie 只认 light/dark（无镜像 = 跟随系统，缺省亮，与 layout
  // no-flash 的缺省一致）；语言只认 TRANSLATIONS 里的合法码，非法/缺失传 null
  // 让客户端回退浏览器探测。
  return (
    <Atamas
      initialLightMode={themePref !== 'dark'}
      initialLang={langPref && TRANSLATIONS[langPref] ? langPref : null}
    />
  );
}
