import { redirect } from 'next/navigation';

// 对齐 Flask tool.translate：直接 302 跳转到外部翻译服务。
// 原实现：return redirect('http://116.62.179.232:9198')
export default function TranslateRedirect() {
  redirect('http://116.62.179.232:9198');
}
