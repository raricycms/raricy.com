from app.extensions import db


class Category(db.Model):
    """
    栏目/分类模型，支持层级结构。
    
    设计支持二级分类：
    - 一级分类：学术版、灌水区、生活版、站务版
    - 二级分类：心理学&哲学&社科、数学&自然科学等
    """
    __tablename__ = 'categories'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False, index=True)
    slug = db.Column(db.String(50), nullable=False, unique=True, index=True)  # URL友好的标识符
    description = db.Column(db.String(200), default='')
    
    # 层级关系：parent_id 为 NULL 表示一级分类
    parent_id = db.Column(db.Integer, db.ForeignKey('categories.id'), nullable=True, index=True)
    
    # 排序权重，用于控制显示顺序
    sort_order = db.Column(db.Integer, default=0, index=True)
    
    # 是否启用该分类
    is_active = db.Column(db.Boolean, default=True, index=True)
    
    # 分类图标（可选，用于前端显示）
    icon = db.Column(db.String(50), default='')

    # 是否从“全部文章”中排除该分类（及其子分类）
    exclude_from_all = db.Column(db.Boolean, default=False, index=True)
    
    # 仅管理员可发文
    admin_only_posting = db.Column(db.Boolean, default=False, index=True)
    
    # 当有用户在该栏目发文时，通知管理员
    notify_admin_on_post = db.Column(db.Boolean, default=False, index=True)
    
    created_at = db.Column(db.DateTime, default=db.func.now())

    # 自关联关系：父分类与子分类
    children = db.relationship(
        'Category',
        backref=db.backref('parent', remote_side=[id]),
        lazy='dynamic'
    )

    def __repr__(self):
        return f'<Category {self.name}>'

    def to_dict(self, include_children=False) -> dict:
        """转换为字典格式，便于序列化"""
        result = {
            'id': self.id,
            'name': self.name,
            'slug': self.slug,
            'description': self.description,
            'parent_id': self.parent_id,
            'sort_order': self.sort_order,
            'is_active': self.is_active,
            'icon': self.icon,
            'exclude_from_all': self.exclude_from_all,
            'admin_only_posting': self.admin_only_posting,
            'notify_admin_on_post': self.notify_admin_on_post,
            'level': 1 if self.parent_id is None else 2
        }
        
        if include_children and self.parent_id is None:
            # 只有一级分类才包含子分类
            result['children'] = [
                child.to_dict() for child in 
                self.children.filter_by(is_active=True).order_by(Category.sort_order).all()
            ]
        
        return result

    def get_full_path(self) -> str:
        """获取完整路径，如：学术版 > 计算机&工程与工业"""
        if self.parent_id is None:
            return self.name
        else:
            return f"{self.parent.name} > {self.name}"

    @classmethod
    def get_hierarchy(cls):
        """获取完整的分类层级结构"""
        root_categories = cls.query.filter_by(parent_id=None, is_active=True).order_by(cls.sort_order).all()
        return [cat.to_dict(include_children=True) for cat in root_categories]


