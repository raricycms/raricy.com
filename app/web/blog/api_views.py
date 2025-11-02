"""
博客API视图
"""
from flask import request, jsonify
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.web.blog.services.like_service import LikeService
from app.web.blog.services.comment_service import CommentService
from app.web.blog.validators.comment_validator import CommentValidator
from app.web.blog.utils.ban_check import check_user_ban_status_for_admin
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

    @blog_bp.route('/<blog_id>/comments', methods=['GET'])
    def list_comments(blog_id):
        """获取文章评论（嵌套树）。"""
        comments = CommentService.list_comments(blog_id)
        return success_response('ok', comments=comments)

    @blog_bp.route('/<blog_id>/comments', methods=['POST'])
    @login_required
    def create_comment(blog_id):
        """创建评论（仅核心用户或管理员）。频率：1分钟1条。"""
        # 禁言检查（管理员除外）
        is_banned, _, ban_error = check_user_ban_status_for_admin()
        if is_banned:
            return ban_error

        data = request.get_json(silent=True) or {}
        ok, msg, validated = CommentValidator.validate_create_data(data)
        if not ok:
            return error_response(msg, 400)

        success, message, comment = CommentService.create_comment(
            blog_id=blog_id,
            content=validated['content'],
            parent_id=validated.get('parent_id')
        )
        if success:
            return success_response(message, comment=comment)
        else:
            code = 429 if '频繁' in message else 400
            return error_response(message, code)

    @blog_bp.route('/comments/<comment_id>', methods=['DELETE'])
    @login_required
    def delete_comment(comment_id):
        """删除评论（作者本人或管理员）。"""
        success, message = CommentService.delete_comment(comment_id)
        if success:
            return success_response(message)
        else:
            code = 403 if '无权' in message else 404 if '不存在' in message else 400
            return error_response(message, code)
