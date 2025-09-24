"""
栏目数据验证器
"""
from app.models import Category


class CategoryValidator:
    """栏目数据验证器"""
    
    @staticmethod
    def validate_category_data(data):
        """
        验证栏目数据
        
        Args:
            data: 栏目数据字典
            
        Returns:
            tuple: (is_valid, error_message, validated_data)
        """
        if not data:
            return False, "缺少必要参数", None
        
        name = (data.get('name') or '').strip()
        slug = (data.get('slug') or '').strip()
        description = (data.get('description') or '').strip()
        icon = (data.get('icon') or '').strip()
        exclude_from_all = bool(data.get('exclude_from_all', False))
        parent_id = data.get('parent_id')
        
        if not name:
            return False, "栏目名称不能为空", None
        if not slug:
            return False, "栏目标识符不能为空", None
        
        # 检查slug是否已存在
        existing = Category.query.filter_by(slug=slug).first()
        if existing:
            return False, "标识符已存在", None
        
        # 验证父栏目
        validated_parent_id = None
        if parent_id:
            try:
                parent_id = int(parent_id)
                parent = Category.query.filter_by(id=parent_id, parent_id=None, is_active=True).first()
                if not parent:
                    return False, "父栏目不存在或不是一级栏目", None
                validated_parent_id = parent_id
            except (ValueError, TypeError):
                return False, "父栏目ID格式错误", None
        
        validated_data = {
            'name': name,
            'slug': slug,
            'description': description,
            'icon': icon,
            'parent_id': validated_parent_id,
            'exclude_from_all': exclude_from_all
        }
        
        return True, None, validated_data
    
    @staticmethod
    def validate_category_update_data(category_id, data):
        """
        验证栏目更新数据
        
        Args:
            category_id: 栏目ID
            data: 更新数据字典
            
        Returns:
            tuple: (is_valid, error_message, validated_data)
        """
        if not data:
            return False, "缺少必要参数", None
        
        name = (data.get('name') or '').strip()
        slug = (data.get('slug') or '').strip()
        description = (data.get('description') or '').strip()
        icon = (data.get('icon') or '').strip()
        is_active = data.get('is_active', True)
        exclude_from_all = bool(data.get('exclude_from_all', False))
        
        if not name:
            return False, "栏目名称不能为空", None
        if not slug:
            return False, "栏目标识符不能为空", None
        
        # 检查slug是否被其他栏目使用
        existing = Category.query.filter(Category.slug == slug, Category.id != category_id).first()
        if existing:
            return False, "标识符已被其他栏目使用", None
        
        validated_data = {
            'name': name,
            'slug': slug,
            'description': description,
            'icon': icon,
            'is_active': is_active,
            'exclude_from_all': exclude_from_all
        }
        
        return True, None, validated_data
