/** 博客目录的范围词表；不依赖服务端模块，供筛选条和个人侧栏共用。 */
export const BLOG_SCOPES = [
  { value: 'all', label: '全部文章', icon: 'icon-journal-text' },
  { value: 'mine', label: '我发布的', icon: 'icon-pencil-fill' },
  { value: 'liked', label: '我赞过的', icon: 'icon-heart-fill' },
  { value: 'fed', label: '我喂过鱼的', icon: 'icon-fish' },
] as const;

export type BlogScope = (typeof BLOG_SCOPES)[number]['value'];
export type PersonalBlogScope = Exclude<BlogScope, 'all'>;

export function parseBlogScope(raw: unknown): BlogScope {
  return raw === 'mine' || raw === 'liked' || raw === 'fed' ? raw : 'all';
}
