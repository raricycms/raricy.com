import type { Metadata } from 'next';
import FooterNote from '@/app/components/FooterNote';

// 对齐 app/templates/home/valid_user.html（Flask 路由 /valid_user）。
// 原模板正文 {% block content %} 为空，仅设置标题与页脚提示"你来对地方了。"。
// 该页无任何生成动作 / 表单——邀请码的生成入口是仅站长可见的 /zhh（见 zhh/route.ts），
// 故此处不需要配套 API。（原模板 `{% extends base.html %}` 缺引号，实际会渲染失败；
// 此处按其显然意图移植为可正常渲染的空内容页。）

export const metadata: Metadata = { title: 'raricy.com - 获取注册资格' };

export default function ValidUserPage() {
  return <FooterNote>你来对地方了。</FooterNote>;
}
