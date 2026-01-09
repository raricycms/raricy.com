
from flask import request, jsonify, abort
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.web.blog.services.blog_service import BlogService
from app.web.blog.services.like_service import LikeService
from app.web.blog.services.comment_service import CommentService
from app.web.blog.validators.comment_validator import CommentValidator
from app.web.blog.utils.ban_check import check_user_ban_status_for_admin
from app.web.blog.utils.response_utils import success_response, error_response, not_found_response

def register_spider_api_views(blog_bp):
    """注册API视图路由"""
    
    @blog_bp.route('/spider/comments', methods=['GET'])
    def all_comments():
        comments_lst = CommentService.get_recent_comments()
        
        return jsonify(comments_lst)

    @blog_bp.route('/spider/comments/<comment_id>')
    def get_comment(comment_id):
        comment = CommentService.get_comment(comment_id=comment_id)
        if not comment:
            return not_found_response('评论不存在')

        return jsonify(comment)

    @blog_bp.route('/spider/blogs/<blog_id>')
    def get_blog(blog_id):
        blog_dict, content = BlogService.get_blog_detail(blog_id)

        if blog_dict is None:
            abort(404)

        return jsonify({'meta': blog_dict, 'content': content})
