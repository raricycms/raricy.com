"""
禁言检查工具函数
"""
from flask import jsonify
from flask_login import current_user


def check_user_ban_status():
    """
    检查当前用户是否被禁言
    
    Returns:
        tuple: (is_banned, ban_info, error_response)
        - is_banned: bool, 是否被禁言
        - ban_info: dict, 禁言信息
        - error_response: tuple, 错误响应 (response, status_code)
    """
    if not current_user.is_authenticated:
        return False, None, None
    
    if current_user.is_currently_banned():
        ban_info = current_user.get_ban_info()
        remaining_text = ""
        
        if ban_info and ban_info.get('remaining_hours'):
            remaining_hours = ban_info['remaining_hours']
            if remaining_hours > 24:
                remaining_text = f"剩余约{remaining_hours/24:.1f}天"
            else:
                remaining_text = f"剩余约{remaining_hours:.1f}小时"
        
        error_message = f'您已被禁言，无法执行此操作。{remaining_text}。原因：{ban_info.get("reason", "未说明") if ban_info else "未说明"}'
        error_response = (jsonify({
            'code': 403, 
            'message': error_message
        }), 403)
        
        return True, ban_info, error_response
    
    return False, None, None


def check_user_ban_status_for_admin():
    """
    检查当前用户是否被禁言（管理员除外）
    
    Returns:
        tuple: (is_banned, ban_info, error_response)
    """
    if not current_user.is_authenticated:
        return False, None, None
    
    # 管理员不受禁言限制
    if current_user.is_admin:
        return False, None, None
    
    return check_user_ban_status()
