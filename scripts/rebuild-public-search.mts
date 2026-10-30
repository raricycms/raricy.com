import { rebuildPublicBlogSearch } from '../src/lib/public-blog-search';
import { prisma } from '../src/lib/db';
try { console.log('已重建公开正文索引：', await rebuildPublicBlogSearch(), '篇'); }
catch (error) { console.error('公开正文索引重建失败', error); process.exitCode=1; }
finally { await prisma.$disconnect(); }
