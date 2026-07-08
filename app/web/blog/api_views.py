"""
博客API视图
"""
from flask import request, jsonify, abort
from flask_login import login_required, current_user
from app.clients.account_client import AccountClientError
from app.extensions.decorators import admin_required, authenticated_required
from app.web.blog.services.blog_service import BlogService
from app.web.blog.services.like_service import LikeService
from app.web.blog.services.comment_service import CommentService
from app.web.blog.services.feed_fish_service import get_feed_status, feed_fish, get_feeders
from app.web.blog.validators.comment_validator import CommentValidator
from app.web.blog.utils.ban_check import check_user_ban_status_for_admin
from app.web.blog.utils.response_utils import success_response, error_response, not_found_response


def register_api_views(blog_bp):
    """注册API视图路由"""
    
    @blog_bp.route('/<blog_id>/like', methods=['POST'])
    @login_required
    @authenticated_required
    def like_toggle(blog_id):
        """
        点赞/取消点赞切换接口。
        
        返回：{ code, liked, likes_count }
        """
        success, message, liked, likes_count = LikeService.toggle_like(blog_id)

        if success:
            return success_response(message, liked=liked, likes_count=likes_count)
        else:
            # 频率限制返回 429，文章不存在返回 404
            code = 429 if '上限' in message or '频繁' in message else 404
            return error_response(message, code)
    
    @blog_bp.route('/<blog_id>/likers', methods=['GET'])
    @login_required
    def likers(blog_id):
        """
        查看点赞者列表。
        支持简单分页参数：?offset=0&limit=50
        """
        blog_dict, _ = BlogService.get_blog_detail(blog_id)
        if not blog_dict:
            return not_found_response('文章不存在')
        if current_user.id != blog_dict['author_id'] and not current_user.has_admin_rights:
            abort(403)
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
        """创建评论（仅核心用户或管理员）。频率：每天1200条。"""
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
            code = 429 if '上限' in message else 400
            return error_response(message, code)

    @blog_bp.route('/comments/<comment_id>', methods=['DELETE'])
    @login_required
    def delete_comment(comment_id):
        """删除评论（作者本人或管理员）。"""
        data = request.get_json(silent=True) or {}
        reason = (data.get('reason') or '').strip()
        success, message = CommentService.delete_comment(comment_id, reason=reason)
        if success:
            return success_response(message)
        else:
            code = 403 if '无权' in message else 404 if '不存在' in message else 400
            return error_response(message, code)

    # ── 小鱼干投喂 API ──

    @blog_bp.route('/<blog_id>/feed-status', methods=['GET'])
    @login_required
    def feed_status(blog_id):
        """获取当前用户对文章的投喂状态。"""
        status = get_feed_status(blog_id, current_user.id)
        return success_response('ok', **status)

    @blog_bp.route('/<blog_id>/feed-fish', methods=['POST'])
    @login_required
    @authenticated_required
    def feed_fish_api(blog_id):
        """投喂小鱼干给文章。"""
        data = request.get_json(silent=True)
        if not data or 'amount' not in data:
            return error_response('请提供投喂数量', 400)

        try:
            amount = float(data['amount'])
            if amount != int(amount):
                return error_response('投喂数量需为整数', 400)
            amount = int(amount)
            if amount < 1 or amount > 5:
                return error_response('投喂数量需在 1~5 之间', 400)
        except (ValueError, TypeError):
            return error_response('无效的投喂数量', 400)

        try:
            result = feed_fish(blog_id, current_user.id, amount)
            return success_response('投喂成功！', **result)
        except ValueError as e:
            msg = str(e)
            code = 400 if '不足' in msg else 404
            return error_response(msg, code)
        except AccountClientError as e:
            # 远端账户服务不可用/失败 → fail-closed，本地已回滚
            return error_response(
                '鱼干服务暂不可用，请稍后再试',
                503,
                detail=str(e),
            )

    @blog_bp.route('/<blog_id>/feeders', methods=['GET'])
    @login_required
    def feeders(blog_id):
        """查看投喂者列表（作者和管理员可见）。"""
        blog_dict, _ = BlogService.get_blog_detail(blog_id)
        if not blog_dict:
            return not_found_response('文章不存在')
        if current_user.id != blog_dict['author_id'] and not current_user.has_admin_rights:
            abort(403)
        try:
            offset = int(request.args.get('offset', 0))
            limit = int(request.args.get('limit', 50))
        except Exception:
            offset, limit = 0, 50

        data = get_feeders(blog_id, offset, limit)
        return success_response('ok', **data)
