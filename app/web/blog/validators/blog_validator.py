"""
博客数据验证器
"""
from app.models import Category
from app.extensions import db


class BlogValidator:
    """博客数据验证器"""
    
    # 常量定义
    MAX_TITLE_LENGTH = 30
    MAX_DESCRIPTION_LENGTH = 100
    MAX_CONTENT_LENGTH = 200000
    
    @staticmethod
    def validate_blog_data(data):
        """
        验证博客数据
        
        Args:
            data: 博客数据字典
            
        Returns:
            tuple: (is_valid, error_message, validated_data)
        """
        if not data:
            return False, "缺少必要参数", None
        
        # 检查必要字段
        title = (data.get('title') or '').strip()
        description = (data.get('description') or '').strip()
        content = data.get('content') or ''
        
        if not title:
            return False, "标题不能为空", None
        if not description:
            return False, "描述不能为空", None
        if not content:
            return False, "内容不能为空", None
        
        # 长度验证
        if len(title) > BlogValidator.MAX_TITLE_LENGTH:
            return False, f"标题不能超过{BlogValidator.MAX_TITLE_LENGTH}个字符", None
        if len(description) > BlogValidator.MAX_DESCRIPTION_LENGTH:
            return False, f"描述不能超过{BlogValidator.MAX_DESCRIPTION_LENGTH}个字符", None
        if len(content) > BlogValidator.MAX_CONTENT_LENGTH:
            return False, f"内容不能超过{BlogValidator.MAX_CONTENT_LENGTH}个字符", None
        
        # 栏目验证
        category_id = data.get('category_id')
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
        
        validated_data = {
            'title': title,
            'description': description,
            'content': content,
            'category_id': validated_category_id
        }
        
        return True, None, validated_data
    
    @staticmethod
    def validate_blog_id(blog_id):
        """
        验证博客ID格式
        
        Args:
            blog_id: 博客ID
            
        Returns:
            bool: 是否有效
        """
        if not blog_id or not isinstance(blog_id, str):
            return False
        
        # UUID格式验证（简单检查长度和字符）
        if len(blog_id) != 36:
            return False
        
        return True
