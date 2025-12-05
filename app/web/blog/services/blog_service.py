"""
博客业务逻辑服务
"""
import os
import uuid
from datetime import datetime
from flask import current_app
from flask_login import current_user
from app.extensions import db
from app.models import Blog, BlogContent, Category
from app.service.notifications import send_notification


class BlogService:
    """博客业务逻辑服务"""
    
    @staticmethod
    def get_blog_list(category_slug=None, featured=None):
        """
        获取博客列表
        
        Args:
            category_slug: 栏目标识符
            
        Returns:
            tuple: (blogs, categories, current_category)
        """
        current_category = None
        
        # 获取栏目层级结构用于导航
        categories = Category.get_hierarchy()
        
        # 构建查询
        query = Blog.query.filter_by(ignore=False)
        
        if category_slug:
            # 按栏目筛选
            current_category = Category.query.filter_by(slug=category_slug, is_active=True).first()
            if current_category:
                if current_category.parent_id is None:
                    # 一级栏目：包含该栏目下的所有文章（包括子栏目）
                    child_ids = [child.id for child in current_category.children.filter_by(is_active=True).all()]
                    category_ids = [current_category.id] + child_ids
                    query = query.filter(Blog.category_id.in_(category_ids))
                else:
                    # 二级栏目：只显示该栏目的文章
                    query = query.filter_by(category_id=current_category.id)
            else:
                # 栏目不存在
                return None, categories, None
        else:
            # 无栏目筛选时，排除被设置为不在“全部文章”显示的分类（及其子分类）
            excluded_ids = []
            try:
                excluded_categories = Category.query.filter_by(exclude_from_all=True, is_active=True).all()
                for ec in excluded_categories:
                    excluded_ids.append(ec.id)
                    # 子分类
                    for child in ec.children.filter_by(is_active=True).all():
                        excluded_ids.append(child.id)
            except Exception:
                excluded_ids = []
            if excluded_ids:
                query = query.filter((Blog.category_id.is_(None)) | (~Blog.category_id.in_(excluded_ids)))

        # 精选筛选
        if featured in (True, False):
            query = query.filter(Blog.is_featured == featured)
        
        blogs = []
        for blog in query.order_by(Blog.created_at.desc()).all():
            item = blog.to_dict()
            blogs.append(item)
        
        return blogs, categories, current_category

    @staticmethod
    def update_featured(blog_id, is_featured):
        """
        更新文章精选状态
        """
        blog = Blog.query.get(blog_id)
        if not blog:
            return False, "文章不存在", None
        blog.is_featured = bool(is_featured)
        db.session.commit()
        return True, ("已设为精选" if blog.is_featured else "已取消精选"), blog.to_dict()

    @staticmethod
    def batch_update_featured(blog_ids, is_featured):
        """
        批量更新精选状态
        """
        if not blog_ids:
            return False, "请选择要更新的文章"
        updated = Blog.query.filter(Blog.id.in_(blog_ids)).update(
            {Blog.is_featured: bool(is_featured)}, synchronize_session=False
        )
        db.session.commit()
        return True, f"已更新 {updated} 篇文章的精选状态"
    
    @staticmethod
    def get_blog_detail(blog_id):
        """
        获取博客详情
        
        Args:
            blog_id: 博客ID
            
        Returns:
            tuple: (blog_dict, content) or (None, None)
        """
        blog = Blog.query.get(blog_id)
        if not blog or blog.ignore:
            return None, None
        
        # 从数据库读取正文
        content_obj = BlogContent.query.get(blog_id)
        content = content_obj.content if content_obj else ''
        
        blog_dict = blog.to_dict()
        blog_dict['content'] = content
        
        # 当前用户是否已点赞
        liked = False
        try:
            if current_user.is_authenticated:
                from app.models import BlogLike
                liked = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first() is not None
        except Exception:
            liked = False
        
        blog_dict['liked'] = liked
        return blog_dict, content
    
    @staticmethod
    def create_blog(validated_data):
        """
        创建新博客
        
        Args:
            validated_data: 验证后的博客数据
            
        Returns:
            str: 博客ID
        """
        # 生成博客 ID，并准备目录
        blog_id = str(uuid.uuid4())
        blog_path = os.path.join(current_app.instance_path, "blogs", blog_id)
        os.makedirs(blog_path, exist_ok=True)
        
        # 写入数据库（元信息）
        blog = Blog(
            id=blog_id,
            title=validated_data['title'],
            description=validated_data['description'],
            author_id=current_user.id,
            category_id=validated_data['category_id'],
            created_at=datetime.now(),
        )
        db.session.add(blog)
        
        # 正文保存到 BlogContent（与 Blog 同事务提交）
        content_obj = BlogContent(blog_id=blog_id, content=validated_data['content'])
        db.session.add(content_obj)
        db.session.commit()
        
        return blog_id
    
    @staticmethod
    def update_blog(blog_id, validated_data):
        """
        更新博客
        
        Args:
            blog_id: 博客ID
            validated_data: 验证后的博客数据
            
        Returns:
            tuple: (has_changes, changes_detail)
        """
        blog = Blog.query.get(blog_id)
        if not blog:
            return False, []
        
        # 检查是否有实际的修改
        has_changes = False
        changes_detail = []
        
        if blog.title != validated_data['title']:
            changes_detail.append(f"标题从《{blog.title}》改为《{validated_data['title']}》")
            has_changes = True
        
        if blog.description != validated_data['description']:
            changes_detail.append("摘要已更新")
            has_changes = True
        
        # 检查栏目变化
        old_category_name = blog.category.name if blog.category else "未分类"
        new_category_name = "未分类"
        if validated_data['category_id']:
            new_category = Category.query.get(validated_data['category_id'])
            if new_category:
                new_category_name = new_category.name
        
        if blog.category_id != validated_data['category_id']:
            changes_detail.append(f"栏目从《{old_category_name}》改为《{new_category_name}》")
            has_changes = True
        
        # 检查内容变化
        content_obj = BlogContent.query.get(blog_id)
        old_content = content_obj.content if content_obj else ''
        if old_content != validated_data['content']:
            changes_detail.append("文章内容已更新")
            has_changes = True
        
        # 更新 Blog 元信息
        blog.title = validated_data['title']
        blog.description = validated_data['description']
        blog.category_id = validated_data['category_id']
        
        # 更新/创建正文 Markdown
        if not content_obj:
            content_obj = BlogContent(blog_id=blog_id, content=validated_data['content'])
            db.session.add(content_obj)
        else:
            content_obj.content = validated_data['content']
        
        db.session.commit()
        
        return has_changes, changes_detail
    
    @staticmethod
    def delete_blog(blog_id, soft_delete=False):
        """
        删除博客
        
        Args:
            blog_id: 博客ID
            soft_delete: 是否软删除（将 ignore 设为 True，而不物理删除）
            
        Returns:
            tuple: (blog_title, blog_author_id)
        """
        blog = Blog.query.get(blog_id)
        if not blog:
            return None, None
        
        # 保存文章信息用于通知
        blog_title = blog.title
        blog_author_id = blog.author_id
        
        # 管理员软删除：仅标记 ignore=True，不做物理删除
        if soft_delete:
            blog.ignore = True
            db.session.commit()
            return blog_title, blog_author_id
        
        # 删除磁盘目录（若存在）
        blog_path = os.path.join(current_app.instance_path, 'blogs', blog_id)
        try:
            import shutil
            shutil.rmtree(blog_path, ignore_errors=True)
        except Exception:
            # 忽略清理错误，继续逻辑删除
            pass
        
        db.session.delete(blog)
        db.session.commit()
        
        return blog_title, blog_author_id
    
    @staticmethod
    def get_blog_for_edit(blog_id):
        """
        获取用于编辑的博客数据
        
        Args:
            blog_id: 博客ID
            
        Returns:
            tuple: (blog_dict, markdown_content, categories)
        """
        blog = Blog.query.get(blog_id)
        if not blog or blog.ignore:
            return None, None, None
        
        # 读取 Markdown 正文
        content_obj = BlogContent.query.get(blog_id)
        markdown_content = content_obj.content if content_obj else ''
        blog_dict = blog.to_dict()
        
        # 获取栏目列表用于下拉选择
        categories = Category.get_hierarchy()
        
        return blog_dict, markdown_content, categories
    
    @staticmethod
    def get_admin_articles(category_id=None, search=None, page=1, per_page=20):
        """
        获取管理员文章列表
        
        Args:
            category_id: 栏目ID
            search: 搜索关键词
            page: 页码
            per_page: 每页数量
            
        Returns:
            tuple: (articles, categories, pagination)
        """
        # 构建查询
        query = Blog.query.filter_by(ignore=False)
        
        # 按栏目筛选
        if category_id == -1:  # 未分类
            query = query.filter_by(category_id=None)
        elif category_id:
            query = query.filter_by(category_id=category_id)
        
        # 搜索标题
        if search:
            query = query.filter(Blog.title.contains(search))
        
        # 分页
        pagination = query.order_by(Blog.created_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )
        
        articles = pagination.items
        categories = Category.get_hierarchy()
        
        return articles, categories, pagination
    
    @staticmethod
    def get_admin_stats():
        """
        获取管理员统计数据
        
        Returns:
            dict: 统计数据
        """
        # 统计数据
        total_blogs = Blog.query.filter_by(ignore=False).count()
        categorized_blogs = Blog.query.filter(Blog.category_id.isnot(None), Blog.ignore == False).count()
        uncategorized_blogs = Blog.query.filter_by(category_id=None, ignore=False).count()
        total_categories = Category.query.filter_by(is_active=True).count()
        total_likes = db.session.query(db.func.sum(Blog.likes_count)).scalar() or 0
        
        # 最近文章
        recent_blogs = Blog.query.filter_by(ignore=False).order_by(Blog.created_at.desc()).limit(5).all()
        
        # 热门文章（按点赞数）
        popular_blogs = Blog.query.filter_by(ignore=False).order_by(Blog.likes_count.desc()).limit(5).all()
        
        # 栏目文章分布
        category_stats = db.session.query(
            Category.name, 
            Category.icon,
            db.func.count(Blog.id).label('blog_count')
        ).outerjoin(Blog, Category.id == Blog.category_id).filter(
            Category.is_active == True,
            Blog.ignore == False
        ).group_by(Category.id, Category.name, Category.icon).all()
        
        stats = {
            'total_blogs': total_blogs,
            'categorized_blogs': categorized_blogs,
            'uncategorized_blogs': uncategorized_blogs,
            'total_categories': total_categories,
            'total_likes': total_likes,
            'recent_blogs': [blog.to_dict() for blog in recent_blogs],
            'popular_blogs': [blog.to_dict() for blog in popular_blogs],
            'category_stats': [{'name': stat[0], 'icon': stat[1], 'count': stat[2]} for stat in category_stats]
        }
        
        return stats
