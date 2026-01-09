#!/usr/bin/env python3
"""
栏目管理脚本 - 添加新栏目
使用方法：python add_category.py
"""
from app import create_app
from app.models import Category
from app.extensions import db
from datetime import datetime

def add_category():
    """添加新栏目"""
    app = create_app()
    with app.app_context():
        print("🐱 栏目添加工具")
        print("=" * 40)

        # 显示现有栏目结构
        print("📋 现有栏目:")
        parents = Category.query.filter_by(parent_id=None).order_by(Category.sort_order).all()
        for i, parent in enumerate(parents, 1):
            print(f"{i}. 📁 {parent.name}")
            for child in parent.children.order_by(Category.sort_order).all():
                print(f"   └─ {child.name}")

        print("\n1. 添加一级栏目")
        print("2. 添加子栏目")
        choice = input("请选择操作 (1/2): ").strip()

        if choice == "1":
            add_parent_category()
        elif choice == "2":
            add_child_category()
        else:
            print("❌ 无效选择喵～")

def add_parent_category():
    """添加一级栏目"""
    print("\n📁 添加一级栏目")
    print("-" * 30)

    name = input("栏目名称: ").strip()
    if not name:
        print("❌ 名称不能为空喵～")
        return

    slug = input("URL标识 (英文): ").strip()
    if not slug:
        print("❌ URL标识不能为空喵～")
        return

    # 检查slug是否已存在
    if Category.query.filter_by(slug=slug).first():
        print("❌ 该URL标识已存在喵～")
        return

    description = input("栏目描述: ").strip()
    icon = input("图标 (可选): ").strip() or "📁"

    # 获取最大排序值
    max_order = db.session.query(db.func.max(Category.sort_order)).filter_by(parent_id=None).scalar() or 0

    category = Category(
        name=name,
        slug=slug,
        description=description,
        icon=icon,
        sort_order=max_order + 1,
        is_active=True,
        created_at=datetime.now()
    )

    db.session.add(category)
    db.session.commit()
    print(f"✅ 一级栏目 '{name}' 添加成功喵！")

def add_child_category():
    """添加子栏目"""
    print("\n📁 添加子栏目")
    print("-" * 30)

    # 显示一级栏目
    parents = Category.query.filter_by(parent_id=None).order_by(Category.sort_order).all()
    if not parents:
        print("❌ 请先创建一级栏目喵～")
        return

    print("请选择父栏目:")
    for i, parent in enumerate(parents, 1):
        print(f"{i}. {parent.name}")

    try:
        choice = int(input("选择序号: ").strip())
        if choice < 1 or choice > len(parents):
            print("❌ 无效选择喵～")
            return
    except ValueError:
        print("❌ 请输入数字喵～")
        return

    parent = parents[choice - 1]

    name = input("子栏目名称: ").strip()
    if not name:
        print("❌ 名称不能为空喵～")
        return

    slug = input("URL标识 (英文): ").strip()
    if not slug:
        print("❌ URL标识不能为空喵～")
        return

    # 检查slug是否已存在
    if Category.query.filter_by(slug=slug).first():
        print("❌ 该URL标识已存在喵～")
        return

    description = input("栏目描述: ").strip()
    icon = input("图标 (可选): ").strip() or "📄"

    # 获取该父栏目下的最大排序值
    max_order = db.session.query(db.func.max(Category.sort_order)).filter_by(parent_id=parent.id).scalar() or 0

    category = Category(
        name=name,
        slug=slug,
        description=description,
        icon=icon,
        parent_id=parent.id,
        sort_order=max_order + 1,
        is_active=True,
        created_at=datetime.now()
    )

    db.session.add(category)
    db.session.commit()
    print(f"✅ 子栏目 '{name}' 添加成功喵！")

if __name__ == '__main__':
    try:
        add_category()
    except Exception as e:
        print(f'发生错误: {e}')
        exit(1)
