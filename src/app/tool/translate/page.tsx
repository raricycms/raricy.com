import { redirect } from 'next/navigation';

// 直接 302 跳转到外部翻译服务。
export default function TranslateRedirect() {
  redirect('http://116.62.179.232:9198');
}
