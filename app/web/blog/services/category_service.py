"""
栏目业务逻辑服务
"""
from datetime import datetime
from app.extensions import db
from app.models import Category, Blog


class CategoryService:
    """栏目业务逻辑服务"""
    
    @staticmethod
    def create_category(validated_data):
        """
        创建新栏目
        
        Args:
            validated_data: 验证后的栏目数据
            
        Returns:
            Category: 创建的栏目对象
        """
        category = Category(
            name=validated_data['name'],
            slug=validated_data['slug'],
            description=validated_data['description'],
            icon=validated_data['icon'],
            parent_id=validated_data['parent_id'],
            exclude_from_all=validated_data.get('exclude_from_all', False),
            sort_order=0,  # 可以后续调整
            is_active=True,
            created_at=datetime.now()
        )
        
        db.session.add(category)
        db.session.commit()
        
        return category
    
    @staticmethod
    def update_category(category_id, validated_data):
        """
        更新栏目信息
        
        Args:
            category_id: 栏目ID
            validated_data: 验证后的栏目数据
            
        Returns:
            Category: 更新的栏目对象
        """
        category = Category.query.get(category_id)
        if not category:
            return None
        
        # 更新栏目信息
        category.name = validated_data['name']
        category.slug = validated_data['slug']
        category.description = validated_data['description']
        category.icon = validated_data['icon']
        category.is_active = validated_data['is_active']
        category.exclude_from_all = validated_data.get('exclude_from_all', category.exclude_from_all)
        
        db.session.commit()
        
        return category
    
    @staticmethod
    def delete_category(category_id):
        """
        删除栏目
        
        Args:
            category_id: 栏目ID
            
        Returns:
            tuple: (success, message)
        """
        category = Category.query.get(category_id)
        if not category:
            return False, "栏目不存在"
        
        # 检查是否有文章在此栏目下
        blog_count = Blog.query.filter_by(category_id=category_id).count()
        if blog_count > 0:
            return False, f"无法删除，该栏目下还有 {blog_count} 篇文章"
        
        # 检查是否有子栏目
        child_count = Category.query.filter_by(parent_id=category_id).count()
        if child_count > 0:
            return False, f"无法删除，该栏目下还有 {child_count} 个子栏目"
        
        db.session.delete(category)
        db.session.commit()
        
        return True, "栏目删除成功"
    
    @staticmethod
    def update_article_category(blog_id, category_id):
        """
        更新文章栏目
        
        Args:
            blog_id: 博客ID
            category_id: 栏目ID
            
        Returns:
            tuple: (success, message, blog_dict)
        """
        blog = Blog.query.get(blog_id)
        if not blog:
            return False, "文章不存在", None
        
        # 验证栏目
        validated_category_id = None
        if category_id:
            try:
                category_id = int(category_id)
                category = Category.query.filter_by(id=category_id, is_active=True).first()
                if not category:
                    return False, "选择的栏目不存在", None
                validated_category_id = category_id
            except (ValueError, TypeError):
                return False, "栏目ID格式错误", None
        
        # 更新栏目
        old_category = blog.category.name if blog.category else '未分类'
        blog.category_id = validated_category_id
        db.session.commit()
        
        new_category = blog.category.name if blog.category else '未分类'
        
        return True, f'文章栏目已从 "{old_category}" 更改为 "{new_category}"', blog.to_dict()
    
    @staticmethod
    def batch_update_article_category(blog_ids, category_id):
        """
        批量更新文章栏目
        
        Args:
            blog_ids: 博客ID列表
            category_id: 栏目ID
            
        Returns:
            tuple: (success, message, updated_count)
        """
        if not blog_ids:
            return False, "请选择要更新的文章", 0
        
        # 验证栏目
        validated_category_id = None
        if category_id:
            try:
                category_id = int(category_id)
                category = Category.query.filter_by(id=category_id, is_active=True).first()
                if not category:
                    return False, "选择的栏目不存在", 0
                validated_category_id = category_id
            except (ValueError, TypeError):
                return False, "栏目ID格式错误", 0
        
        # 批量更新
        updated_count = Blog.query.filter(Blog.id.in_(blog_ids)).update(
            {Blog.category_id: validated_category_id}, synchronize_session=False
        )
        db.session.commit()
        
        category_name = category.name if category_id else '未分类'
        
        return True, f'已将 {updated_count} 篇文章分配到 "{category_name}"', updated_count
