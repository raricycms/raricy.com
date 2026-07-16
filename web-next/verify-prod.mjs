import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const models = ['user','blog','blogContent','blogLike','blogComment','commentLike','category','notification','clipBoard','clipText','imageHosting','photoWallItem','vote','voteOption','voteRecord','dailyCheckIn','fishTransaction','blogFeed','adminActionLog','adminActionAppeal','inviteCode','userBan'];
let fail = 0;
try {
  // 1) read first row of EVERY model — catches any datetime/JSON conversion error per table
  for (const m of models) {
    try { await p[m].findFirst(); process.stdout.write('.'); }
    catch (e) { console.log(`\n  ❌ ${m}: ${String(e.message).split('\n').slice(-1)[0]}`); fail++; }
  }
  console.log('\n  all-model read: ' + (fail? `${fail} FAILED` : 'OK'));
  // 2) counts
  const [u,b,c,n] = await Promise.all([p.user.count(),p.blog.count(),p.blogComment.count(),p.notification.count()]);
  console.log(`  counts: users=${u} blogs=${b} comments=${c} notifications=${n}`);
  // 3) heavy join + datetime serialize (real scale)
  const blog = await p.blog.findFirst({ where:{ignore:false}, orderBy:{createdAt:'desc'}, select:{id:true,title:true,createdAt:true,author:{select:{username:true}},category:{select:{name:true}},_count:{select:{likes:true,comments:true}}}});
  console.log('  latest blog:', JSON.stringify(blog));
  // 4) the JSON-column path (audit) at real scale
  const logs = await p.adminActionLog.findMany({ where:{visibility:'public'}, take:2, orderBy:{createdAt:'desc'}, select:{id:true,action:true,createdAt:true} });
  console.log('  audit logs sample:', logs.length, 'rows read OK');
} catch(e){ console.log('FATAL', e.message); fail++; }
finally { await p.$disconnect(); }
process.exit(fail? 1:0);
