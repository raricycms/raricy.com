"""
博客API视图
"""
from flask import request, jsonify
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.web.blog.services.like_service import LikeService
from app.web.blog.utils.response_utils import success_response, error_response, not_found_response


def register_api_views(blog_bp):
    """注册API视图路由"""
    
    @blog_bp.route('/<blog_id>/like', methods=['POST'])
    @login_required
    def like_toggle(blog_id):
        """
        点赞/取消点赞切换接口。
        
        返回：{ code, liked, likes_count }
        """
        success, message, liked, likes_count = LikeService.toggle_like(blog_id)
        
        if success:
            return success_response(message, liked=liked, likes_count=likes_count)
        else:
            return error_response(message, 404)
    
    @blog_bp.route('/<blog_id>/likers', methods=['GET'])
    @login_required
    @admin_required
    def likers(blog_id):
        """
        管理员查看点赞者列表。
        支持简单分页参数：?offset=0&limit=50
        """
        try:
            offset = int(request.args.get('offset', 0))
            limit = int(request.args.get('limit', 50))
        except Exception:
            offset, limit = 0, 50
        
        success, message, data = LikeService.get_likers(blog_id, offset, limit)
        
        if success:
            return success_response(message, **data)
        else:
            return not_found_response(message)
