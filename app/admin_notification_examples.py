#!/usr/bin/env python3
"""
管理员通知功能使用示例

这个文件演示了如何在代码中使用管理员通知功能。
通常这些功能会通过Web界面操作，但也可以在脚本或其他地方调用。
"""

from app import create_app
from app.service.notifications import (
    admin_send_notification_to_user,
    admin_send_notification_to_all,
    admin_get_notification_templates
)
from app.models import User

def example_send_to_specific_user():
    """示例：向特定用户发送通知"""
    with create_app().app_context():
        # 假设管理员ID是 admin_user_id，目标用户ID是 target_user_id
        # 在实际使用中，这些ID来自数据库查询或Web请求
        
        admin_user = User.query.filter_by(is_admin=True).first()
        target_user = User.query.filter_by(is_admin=False).first()
        
        if admin_user and target_user:
            result = admin_send_notification_to_user(
                admin_id=admin_user.id,
                recipient_id=target_user.id,
                action="系统公告",
                detail="欢迎使用我们的新功能！现在你可以收到管理员的通知了。",
                object_type="system",
                object_id="welcome"
            )
            
            print(f"发送结果: {result}")
        else:
            print("未找到合适的管理员或用户进行测试")

def example_send_to_all_users():
    """示例：向所有用户群发通知"""
    with create_app().app_context():
        admin_user = User.query.filter_by(is_admin=True).first()
        
        if admin_user:
            result = admin_send_notification_to_all(
                admin_id=admin_user.id,
                action="维护通知",
                detail="系统将于今晚22:00-24:00进行维护升级，期间可能无法访问。感谢您的理解！",
                target_group="all"  # 发送给所有用户
            )
            
            print(f"群发结果: {result}")
        else:
            print("未找到管理员用户进行测试")

def example_send_to_authenticated_users():
    """示例：只向认证用户发送通知"""
    with create_app().app_context():
        admin_user = User.query.filter_by(is_admin=True).first()
        
        if admin_user:
            result = admin_send_notification_to_all(
                admin_id=admin_user.id,
                action="功能更新",
                detail="新增了博客评论功能，认证用户现在可以对文章进行评论了！",
                target_group="authenticated"  # 只发送给认证用户
            )
            
            print(f"认证用户群发结果: {result}")
        else:
            print("未找到管理员用户进行测试")

def show_notification_templates():
    """显示可用的通知模板"""
    templates = admin_get_notification_templates()
    
    print("可用的通知模板:")
    print("-" * 50)
    for i, template in enumerate(templates, 1):
        print(f"{i}. {template['action']}")
        print(f"   描述: {template['description']}")
        print(f"   提示: {template['placeholder']}")
        print()

if __name__ == '__main__':
    print("管理员通知功能使用示例")
    print("=" * 50)
    
    # 显示可用模板
    show_notification_templates()
    
    # 运行示例（注释掉以避免在导入时执行）
    # example_send_to_specific_user()
    # example_send_to_all_users()
    # example_send_to_authenticated_users()
    
    print("示例代码执行完成。要实际发送通知，请取消注释相应的函数调用。")
