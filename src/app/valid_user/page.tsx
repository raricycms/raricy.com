import { legacyRedirect } from '@/lib/legacy-redirect';
// 旧「获取注册资格」页已无入口（邀请码流程写在 /register）；307 保住旧直链与查询参数。
export default async function LegacyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  return legacyRedirect('/register',searchParams);
}
