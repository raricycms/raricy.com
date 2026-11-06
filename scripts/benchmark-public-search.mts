// 合成语料基准，仅在系统临时目录建库，绝不读取/修改站点数据。
//
// 两条执行契约（2026-11 修）：
// 1. `node:sqlite` 经 `createRequire` 加载：vite-node 会把顶层 `import 'node:sqlite'`
//    当成 npm 包解析（同仓 reactive-corpus-report.mjs / checkin-migrations.test.ts
//    都踩过，注释里有记录）。
// 2. 被调用的 `searchPublicBlogIds` 所在模块在**加载时**就 `import './db'` 并构造
//    PrismaClient（按 DATABASE_URL）。所以在动态 import 它之前，先把 DATABASE_URL
//    指向本脚本的临时库：那个单例连的是临时文件，既不需要真实 DATABASE_URL，也不会
//    把 WAL PRAGMA 写进站点库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'raricy-public-search-'));
const file=path.join(dir,'benchmark.db');
process.env.DATABASE_URL = 'file:' + file.replace(/\\/g, '/');
const { searchTerms, searchPublicBlogIds, PUBLIC_SEARCH_VERSION } = await import('../src/lib/public-blog-search');
const siteDb = await import('../src/lib/db');
const db=new DatabaseSync(file);
let client: PrismaClient | undefined;
try {
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,archived_at TEXT);
    CREATE TABLE blogs(id TEXT PRIMARY KEY,title TEXT,description TEXT,author_id TEXT,created_at TEXT,visibility TEXT,ignore INTEGER,category_id INTEGER);
    CREATE INDEX ix_visibility ON blogs(visibility,ignore);
    CREATE TABLE blog_contents(blog_id TEXT PRIMARY KEY,content TEXT,format TEXT);
    INSERT INTO users VALUES('bench','benchmark',NULL);`);
  db.exec(fs.readFileSync('prisma/migrations/39_public_blog_search/migration.sql','utf8'));
  const blog=db.prepare('INSERT INTO blogs VALUES(?,?,?,?,?,?,?,?)');
  const state=db.prepare('INSERT INTO public_blog_search_state VALUES(?,?,?)');
  const index=db.prepare('INSERT INTO public_blog_search(rowid,blog_id,body,folded,tokens,version,body_status) VALUES(?,?,?,?,?,?,?)');
  let seed=123456789, bytes=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const buildAt=performance.now();
  db.exec('BEGIN');
  for(let i=0;i<6200;i++){
    const id='bench-'+i;
    const body=Array.from({length:2600},()=>String.fromCodePoint(0x4e00+random()%3000)).join('')
      +(i%20===0?' 山间有风 Autumn visibleCode ':'')+(i%2===0?'文':'');
    bytes+=Buffer.byteLength(body);
    blog.run(id,'合成文章 '+i,'摘要','bench','2026-10-30 00:00:00','public',0,null);
    index.run(i+1,id,body,body.toLowerCase(),searchTerms(body),PUBLIC_SEARCH_VERSION,'ready');
    state.run(id,PUBLIC_SEARCH_VERSION,'ready');
  }
  db.exec('COMMIT');
  console.log(JSON.stringify({articles:6200,sourceMiB:+(bytes/1024/1024).toFixed(2),dbMiB:+(fs.statSync(file).size/1024/1024).toFixed(2),buildSeconds:+((performance.now()-buildAt)/1000).toFixed(2)}));
  db.close();
  client=new PrismaClient({datasources:{db:{url:'file:'+file}}});
  const search=(q:string)=>client!.$transaction(tx=>searchPublicBlogIds(tx,q,null,1,20),{maxWait:30000,timeout:30000});
  const queries=['文','山间','山间有风','autumn','visibleCode','不存在的关键词'];
  for(const q of queries){
    await search(q);
    const times:number[]=[];let count=0;
    for(let j=0;j<30;j++){const at=performance.now();const r=await search(q);times.push(performance.now()-at);count=r.total;}
    times.sort((a,b)=>a-b);
    console.log(JSON.stringify({query:q,hits:count,p50ms:+times[15].toFixed(2),p95ms:+times[28].toFixed(2)}));
  }
  const at=performance.now();
  await Promise.all(Array.from({length:8},async(_,i)=>{for(let j=0;j<10;j++)await search(queries[(i+j)%queries.length]);}));
  console.log(JSON.stringify({concurrent:8,queries:80,seconds:+((performance.now()-at)/1000).toFixed(2)}));
} finally {
  try{db.close();}catch{}
  await client?.$disconnect();
  // 站点单例也连在临时库上；先断开再删目录，避免 Windows 上文件仍被占用。
  await siteDb.prisma.$disconnect().catch(() => {});
  if(path.dirname(dir)!==os.tmpdir())throw new Error('临时目录校验失败');
  try { fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:250}); }
  catch { console.warn('临时库清理稍后重试：',dir); }
}
