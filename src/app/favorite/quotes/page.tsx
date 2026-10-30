import { legacyRedirect } from '@/lib/legacy-redirect';
export default async function LegacyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  return legacyRedirect('/quotes/saved',searchParams);
}
