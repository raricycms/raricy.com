"""
响应工具函数
"""
from flask import jsonify


def success_response(message="操作成功", data=None, **kwargs):
    """
    创建成功响应
    
    Args:
        message: 成功消息
        data: 响应数据
        **kwargs: 其他响应字段
    
    Returns:
        tuple: (response, status_code)
    """
    response_data = {
        'code': 200,
        'message': message
    }
    
    if data is not None:
        response_data['data'] = data
    
    response_data.update(kwargs)
    
    return jsonify(response_data), 200


def error_response(message="操作失败", code=400, **kwargs):
    """
    创建错误响应
    
    Args:
        message: 错误消息
        code: 错误代码
        **kwargs: 其他响应字段
    
    Returns:
        tuple: (response, status_code)
    """
    response_data = {
        'code': code,
        'message': message
    }
    response_data.update(kwargs)
    
    return jsonify(response_data), code


def validation_error_response(message="参数验证失败"):
    """
    创建参数验证错误响应
    """
    return error_response(message, 400)


def not_found_response(message="资源不存在"):
    """
    创建404错误响应
    """
    return error_response(message, 404)


def forbidden_response(message="权限不足"):
    """
    创建403错误响应
    """
    return error_response(message, 403)
