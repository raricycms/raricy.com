/** 目录链接共用同一组筛选；换分类、切范围、清搜索都回第一页，并保留其余条件。 */
export function blogDirectoryHref(
  basePath: '/blog' | '/explore',
  filters: {
    category?: string | null;
    featured?: '1' | '0' | null;
    search?: string | null;
    sort?: 'created' | 'updated' | null;
  },
): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.featured) params.set('featured', filters.featured);
  if (filters.search) params.set('search', filters.search);
  if (filters.sort) params.set('sort', filters.sort);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
