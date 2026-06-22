"""
博客管理员视图
"""
from flask import render_template, request, jsonify
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.service.notifications import send_notification
from app.web.blog.services.blog_service import BlogService
from app.web.blog.utils.response_utils import success_response, error_response, not_found_response, forbidden_response
from app.service.audit_log import log_admin_action


def register_admin_views(blog_bp):
    """注册管理员视图路由"""

    @blog_bp.route('/admin')
    @login_required
    @admin_required
    def admin_dashboard():
        """
        博客管理后台首页（仅管理员）
        """
        stats = BlogService.get_admin_stats()
        return render_template('blog/admin_dashboard.html', stats=stats)

    @blog_bp.route('/admin/articles')
    @login_required
    @admin_required
    def manage_articles():
        """
        文章栏目管理页面（仅管理员）
        """
        # 获取筛选参数
        category_id = request.args.get('category_id', type=int)
        search = request.args.get('search', '').strip()
        page = request.args.get('page', 1, type=int)

        articles, categories, pagination = BlogService.get_admin_articles(
            category_id=category_id,
            search=search,
            page=page
        )

        return render_template('blog/manage_articles.html',
                             articles=articles,
                             categories=categories,
                             pagination=pagination,
                             current_category_id=category_id,
                             search=search)

    @blog_bp.route('/admin/articles/<blog_id>/featured', methods=['PUT'])
    @login_required
    @admin_required
    def update_article_featured(blog_id):
        """
        更新文章精选状态（仅管理员）
        """
        data = request.get_json() or {}
        is_featured = bool(data.get('is_featured'))
        success, message, blog_dict = BlogService.update_featured(blog_id, is_featured)
        if success:
            return success_response(message, blog=blog_dict)
        else:
            return error_response(message, 404)

    @blog_bp.route('/admin/articles/batch-featured', methods=['POST'])
    @login_required
    @admin_required
    def batch_update_featured():
        data = request.get_json() or {}
        blog_ids = data.get('blog_ids', [])
        is_featured = bool(data.get('is_featured'))
        success, message = BlogService.batch_update_featured(blog_ids, is_featured)
        if success:
            return success_response(message)
        else:
            return error_response(message, 400)

    @blog_bp.route('/admin/articles/<blog_id>/category', methods=['PUT'])
    @login_required
    @admin_required
    def update_article_category(blog_id):
        """
        更新文章栏目（仅管理员）
        """
        data = request.get_json()
        category_id = data.get('category_id')

        success, message, blog_dict = CategoryService.update_article_category(blog_id, category_id)

        if success:
            return success_response(message, blog=blog_dict)
        else:
            return error_response(message, 400)

    @blog_bp.route('/admin/articles/batch-category', methods=['POST'])
    @login_required
    @admin_required
    def batch_update_category():
        """
        批量更新文章栏目（仅管理员）
        """
        data = request.get_json()
        blog_ids = data.get('blog_ids', [])
        category_id = data.get('category_id')

        success, message, updated_count = CategoryService.batch_update_article_category(blog_ids, category_id)

        if success:
            return success_response(message)
        else:
            return error_response(message, 400)

    # ---- 文章删除路由 ----

    @blog_bp.route('/<blog_id>', methods=['DELETE'])
    @login_required
    def delete_blog(blog_id):
        """
        删除文章：仅作者本人可删除。
        - 软删除：设置 ignore=True
        """
        from app.models import Blog

        blog = Blog.query.get(blog_id)
        if not blog:
            return not_found_response('未找到文章')

        # 权限：仅作者本人
        if blog.author_id != current_user.id:
            return forbidden_response('无权删除该文章')

        BlogService.delete_blog(blog_id, soft_delete=True)
        return success_response('文章已删除')

    @blog_bp.route('/admin/articles/<blog_id>', methods=['DELETE'])
    @login_required
    @admin_required
    def admin_delete_blog(blog_id):
        """
        管理员删除文章（仅管理员）。
        需要删除原因，并向作者发送通知，记录审计日志。
        """
        from app.models import Blog
        from flask import current_app as flask_app

        blog = Blog.query.get(blog_id)
        if not blog:
            return not_found_response('未找到文章')

        data = request.get_json(silent=True) or {}
        reason = (data.get('reason') or '').strip()
        if not reason:
            return error_response('请提供删除原因', 400)
        if len(reason) > 500:
            return error_response('删除原因过长（最多500字）', 400)

        blog_title, blog_author_id = BlogService.delete_blog(blog_id, soft_delete=True)

        # 通知作者（管理员删他人文章时）
        if blog_author_id and blog_author_id != current_user.id:
            try:
                send_notification(
                    recipient_id=blog_author_id,
                    action="文章删除",
                    actor_id=current_user.id,
                    object_type="blog",
                    object_id=blog_id,
                    detail=f"你的文章《{blog_title}》已被管理员删除。\n原因：{reason}"
                )
            except Exception as e:
                flask_app.logger.warning(f"Failed to send delete notification: {e}")

        # 记录审计日志
        if blog_author_id:
            try:
                log_admin_action(
                    action='delete_blog',
                    admin_id=current_user.id,
                    target_user_id=blog_author_id,
                    object_type='blog',
                    object_id=blog_id,
                    reason=reason,
                    metadata={'blog_title': blog_title}
                )
            except Exception:
                pass

        return success_response('文章已删除')
