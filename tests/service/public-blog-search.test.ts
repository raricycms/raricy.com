import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { listPublicBlogs, createBlog, updateBlog, setBlogVisibility } from '@/lib/blog-service';
import { setBlogIgnore } from '@/lib/admin-blog-service';
import { publicBodyText, syncPublicBlogSearch, rebuildPublicBlogSearch } from '@/lib/public-blog-search';
beforeEach(resetDb);

describe('公开正文索引', () => {
  it('中文单字、双字、短语与英文可检索，并提供上下文；只出 public', async () => {
    const pub = await makeBlog({ visibility:'public', content:'# 标题\n\n山间有风，Autumn sunshine。\n\n\x60\x60\x60js\nconst visibleCode = 3;\n\x60\x60\x60' });
    await makeBlog({ visibility:'link', content:'山间有风 Autumn' });
    await makeBlog({ visibility:'internal', content:'山间有风 Autumn' });
    await makeBlog({ visibility:'public', ignore:true, content:'山间有风 Autumn' });
    for (const q of ['山','山间','山间有风','autumn','visibleCode']) {
      const r = await listPublicBlogs({ search:q });
      expect(r.searchAvailability).toBe('ready');
      expect(r.blogs.map(b=>b.id)).toEqual([pub.id]);
      expect(r.total).toBe(1);
      expect(r.blogs[0].snippet).toContain(q==='autumn'?'Autumn':q);
    }
  });
  it('只索引可读文字，不收引用、隐藏状态、实现代码或失败源码', async () => {
    const r=await publicBodyText('<const name="secret" value="{{ \'HiddenSentinel\' }}" />\n\n可见静态段落 [@AbCd1234]\n\n<if when="{{ false }}">HiddenChild</if>','reactive');
    expect(r.text).toContain('可见静态段落');
    for(const secret of ['HiddenSentinel','HiddenChild','AbCd1234','secret','when']) expect(r.text).not.toContain(secret);
    expect(await publicBodyText('<input bind="broken" type="nonsense" />','weird')).toEqual({text:'',status:'missing'});
  });
  it('编辑、改格式、公开/撤回、删除/恢复同步更新；失效旧行不可泄露', async () => {
    const u=await makeUser({role:'core'});
    const data={title:'普通标题',description:'简介',content:'旧正文山风',categoryId:null,visibility:'public' as const,format:'markdown' as const};
    const id=await createBlog(u.id,data);
    expect((await listPublicBlogs({search:'旧正文山风'})).total).toBe(1);
    await updateBlog(id,{...data,content:'新的正文海风'},u.id);
    expect((await listPublicBlogs({search:'旧正文山风'})).total).toBe(0);
    expect((await listPublicBlogs({search:'新的正文海风'})).total).toBe(1);
    for(const visibility of ['internal','link'] as const) {
      await setBlogVisibility(id,visibility,u.id);
      expect((await listPublicBlogs({search:'新的正文海风'})).total).toBe(0);
      await setBlogVisibility(id,'public',u.id);
      expect((await listPublicBlogs({search:'新的正文海风'})).total).toBe(1);
    }
    await setBlogIgnore(id,true);
    expect((await listPublicBlogs({search:'新的正文海风'})).total).toBe(0);
    await setBlogIgnore(id,false);
    expect((await listPublicBlogs({search:'新的正文海风'})).total).toBe(1);
    // 模拟任意遗漏索引维护的写入者，数据库触发器先撤回旧片段。
    await prisma.blogContent.update({where:{blogId:id},data:{content:'第三版文字'}});
    const stale=await listPublicBlogs({search:'新的正文海风'});
    expect(stale.total).toBe(0);
    expect(stale.searchAvailability).toBe('metadata-only');
    await syncPublicBlogSearch(id);
    expect((await listPublicBlogs({search:'第三版文字'})).total).toBe(1);
  });
  it('旧索引和归档作者不能影响搜索计数、分页或片段', async () => {
    const u=await makeUser({role:'core'});
    const a=await makeBlog({authorId:u.id,visibility:'public',title:'哨兵标题',content:'哨兵正文'});
    await prisma.user.update({where:{id:u.id},data:{archivedAt:new Date('2026-10-30T00:00:00Z')}});
    const hidden=await listPublicBlogs({search:'哨兵'});
    expect(hidden.total).toBe(0); expect(hidden.blogs).toEqual([]);
    const b=await makeBlog({visibility:'public',title:'哨兵标题',content:'哨兵正文'});
    await prisma.$executeRaw`UPDATE public_blog_search_state SET version='old' WHERE blog_id=${b.id}`;
    await prisma.$executeRaw`UPDATE public_blog_search SET version='old' WHERE blog_id=${b.id}`;
    const old=await listPublicBlogs({search:'哨兵'});
    expect(old.searchAvailability).toBe('metadata-only');
    expect(old.total).toBe(1); expect(old.blogs[0].snippet).toBeNull();
  });
  it('排序按标题/简介/作者/正文相关性及日期和 ID 稳定分页', async () => {
    const b=await makeBlog({visibility:'public',title:'正文项',content:'关键词山风'});
    const a=await makeBlog({visibility:'public',title:'关键词山风',content:'其他'});
    const one=await listPublicBlogs({search:'关键词山风',perPage:1});
    const two=await listPublicBlogs({search:'关键词山风',perPage:1,page:2});
    expect(one.blogs.map(x=>x.id)).toEqual([a.id]);
    expect(two.blogs.map(x=>x.id)).toEqual([b.id]);
    expect(one.total).toBe(2);
    expect((await listPublicBlogs({search:'关键词山风',page:99})).total).toBe(2);
  });
  it('历史回填可重复执行，短语必须连续；MATCH 运算符仅作文字', async () => {
    const b=await makeBlog({visibility:'public',content:'山间有清风 甲乙乙丙 a AND b'});
    await prisma.$transaction([prisma.$executeRaw`DELETE FROM public_blog_search`,prisma.$executeRaw`DELETE FROM public_blog_search_state`]);
    expect((await listPublicBlogs({search:'山间'})).searchAvailability).toBe('metadata-only');
    await rebuildPublicBlogSearch(); await rebuildPublicBlogSearch();
    expect((await listPublicBlogs({search:'山间'})).blogs[0].id).toBe(b.id);
    expect((await listPublicBlogs({search:'甲乙丙'})).total).toBe(0);
    expect((await listPublicBlogs({search:'a AND b'})).total).toBe(1);
    expect((await listPublicBlogs({search:'" OR *'})).total).toBe(0);
  });
});
