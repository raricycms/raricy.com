import { redirect } from 'next/navigation';
/** 兼容旧页面路径，保留分页及其它查询参数；新路径由调用处固定给出。 */
export async function legacyRedirect(target:string, params:Promise<Record<string,string|string[]|undefined>>){
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(await params)){
    if(Array.isArray(value))for(const entry of value)query.append(key,entry);
    else if(value!==undefined)query.set(key,value);
  }
  redirect(target+(query.size?'?'+query.toString():''));
}
