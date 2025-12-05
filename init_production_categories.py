#!/usr/bin/env python3
"""
生产环境栏目初始化脚本

在服务器上执行此脚本来初始化栏目数据
使用方法：python init_production_categories.py
"""
from app import create_app
from app.models import Category
from app.extensions import db
from datetime import datetime

def init_categories():
    """初始化栏目数据"""
    app = create_app()
    with app.app_context():
        # 检查是否已有栏目数据
        existing_count = Category.query.count()
        if existing_count > 0:
            print(f"⚠️  发现已有 {existing_count} 个栏目，跳过初始化")
            return
        
        print("🚀 开始初始化栏目数据...")
        
        # 栏目数据
        categories_data = [
            # 学术版
            {
                'name': '学术版',
                'slug': 'academic',
                'description': '学术探讨与研究分享',
                'icon': '🎓',
                'sort_order': 1,
                'children': [
                    {'name': '心理学&哲学&社科', 'slug': 'psychology-philosophy-social', 'description': '心理学、哲学与社会科学', 'icon': '🧠', 'sort_order': 1},
                    {'name': '数学&自然科学', 'slug': 'math-natural-science', 'description': '数学与自然科学领域', 'icon': '🔬', 'sort_order': 2},
                    {'name': '文学&艺术', 'slug': 'literature-art', 'description': '文学创作与艺术作品', 'icon': '🎨', 'sort_order': 3},
                    {'name': '综合探讨', 'slug': 'comprehensive-discussion', 'description': '跨学科综合性讨论', 'icon': '💭', 'sort_order': 4},
                    {'name': '计算机&工程与工业', 'slug': 'computer-engineering-industry', 'description': '计算机科学、工程与工业技术', 'icon': '💻', 'sort_order': 5},
                ]
            },
            # 灌水区
            {
                'name': '灌水区',
                'slug': 'casual',
                'description': '轻松愉快的闲聊天地',
                'icon': '💧',
                'sort_order': 2,
                'children': []
            },
            # 生活版
            {
                'name': '生活版',
                'slug': 'life',
                'description': '生活经验与日常分享',
                'icon': '🏠',
                'sort_order': 3,
                'children': [
                    {'name': '杂谈&随笔', 'slug': 'chitchat-essay', 'description': '日常杂谈与随笔', 'icon': '📝', 'sort_order': 1},
                    {'name': '游戏&娱乐', 'slug': 'game-entertainment', 'description': '游戏与娱乐话题', 'icon': '🎮', 'sort_order': 2},
                    {'name': '经验&工具分享', 'slug': 'experience-tools', 'description': '实用经验与工具推荐', 'icon': '🛠️', 'sort_order': 3},
                    {'name': '见闻&趣事', 'slug': 'news-interesting', 'description': '见闻分享与趣事记录', 'icon': '👀', 'sort_order': 4},
                ]
            },
            # 站务版
            {
                'name': '站务版',
                'slug': 'admin',
                'description': '网站管理与服务',
                'icon': '⚙️',
                'sort_order': 4,
                'children': [
                    {'name': '反馈&申请', 'slug': 'feedback-request', 'description': '意见反馈与各类申请', 'icon': '📮', 'sort_order': 1},
                    {'name': '教程&帮助', 'slug': 'tutorial-help', 'description': '使用教程与帮助文档', 'icon': '📚', 'sort_order': 2},
                    {'name': '更新日志', 'slug': 'update-log', 'description': '系统更新与版本记录', 'icon': '📋', 'sort_order': 3},
                    {'name': '通知&公告', 'slug': 'notice-announcement', 'description': '重要通知与公告', 'icon': '📢', 'sort_order': 4},
                ]
            }
        ]
        
        # 创建栏目
        total_created = 0
        for cat_data in categories_data:
            print(f"📁 创建一级栏目: {cat_data['name']}")
            
            parent_category = Category(
                name=cat_data['name'],
                slug=cat_data['slug'],
                description=cat_data['description'],
                icon=cat_data['icon'],
                sort_order=cat_data['sort_order'],
                is_active=True,
                created_at=datetime.now()
            )
            db.session.add(parent_category)
            db.session.flush()  # 获取父栏目的ID
            total_created += 1
            
            # 创建子栏目
            for child_data in cat_data['children']:
                print(f"   └─ 创建子栏目: {child_data['name']}")
                
                child_category = Category(
                    name=child_data['name'],
                    slug=child_data['slug'],
                    description=child_data['description'],
                    icon=child_data['icon'],
                    parent_id=parent_category.id,
                    sort_order=child_data['sort_order'],
                    is_active=True,
                    created_at=datetime.now()
                )
                db.session.add(child_category)
                total_created += 1
        
        db.session.commit()
        print(f"✅ 栏目初始化完成！共创建 {total_created} 个栏目")
        
        # 显示创建的栏目
        print("\n📋 栏目结构:")
        for category in Category.query.filter_by(parent_id=None).order_by(Category.sort_order).all():
            print(f"📁 {category.name} ({category.slug})")
            for child in category.children.order_by(Category.sort_order).all():
                print(f"   └─ {child.name} ({child.slug})")

if __name__ == '__main__':
    print("🏷️  生产环境栏目初始化")
    print("=" * 50)
    
    try:
        init_categories()
        print("\n🎉 初始化成功！")
    except Exception as e:
        print(f"\n❌ 初始化失败: {e}")
        exit(1)
