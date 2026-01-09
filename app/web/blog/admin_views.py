"""
博客管理员视图
"""
from flask import render_template, request, jsonify
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.service.notifications import send_notification
from app.web.blog.services.blog_service import BlogService
from app.web.blog.services.category_service import CategoryService
from app.web.blog.validators.category_validator import CategoryValidator
from app.web.blog.utils.response_utils import success_response, error_response, validation_error_response, not_found_response, forbidden_response
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
    
    @blog_bp.route('/admin/categories')
    @login_required
    @admin_required
    def manage_categories():
        """
        栏目管理页面（仅管理员）
        """
        from app.models import Category
        categories = Category.get_hierarchy()
        return render_template('blog/manage_categories.html', categories=categories)
    
    @blog_bp.route('/admin/categories', methods=['POST'])
    @login_required
    @admin_required
    def create_category():
        """
        创建新栏目（仅管理员）
        """
        data = request.get_json()
        
        # 验证栏目数据
        is_valid, error_message, validated_data = CategoryValidator.validate_category_data(data)
        if not is_valid:
            return validation_error_response(error_message)
        
        # 创建栏目
        category = CategoryService.create_category(validated_data)
        
        return success_response('栏目创建成功', category=category.to_dict())
    
    @blog_bp.route('/admin/categories/<int:category_id>', methods=['PUT'])
    @login_required
    @admin_required
    def update_category(category_id):
        """
        更新栏目信息（仅管理员）
        """
        data = request.get_json()
        
        # 验证栏目更新数据
        is_valid, error_message, validated_data = CategoryValidator.validate_category_update_data(category_id, data)
        if not is_valid:
            return validation_error_response(error_message)
        
        # 更新栏目
        category = CategoryService.update_category(category_id, validated_data)
        if not category:
            return not_found_response('栏目不存在')
        
        return success_response('栏目更新成功', category=category.to_dict())
    
    @blog_bp.route('/admin/categories/<int:category_id>', methods=['DELETE'])
    @login_required
    @admin_required
    def delete_category(category_id):
        """
        删除栏目（仅管理员）
        
        注意：删除栏目前需要先将该栏目下的文章移动到其他栏目或设为未分类
        """
        success, message = CategoryService.delete_category(category_id)
        
        if success:
            return success_response(message)
        else:
            return error_response(message, 400)
    
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
    
    @blog_bp.route('/<blog_id>', methods=['DELETE'])
    @login_required
    def delete_blog(blog_id):
        """
        删除文章：作者或管理员可删除。
        - 删除 Blog、BlogContent、BlogLike，并清理 instance/blogs/<id> 目录。
        - 若管理员删除他人文章，向作者发送通知。
        """
        from app.models import Blog

        blog = Blog.query.get(blog_id)
        if not blog:
            return not_found_response('未找到文章')

        # 权限：作者本人或管理员
        if not (getattr(current_user, 'has_admin_rights', False) or blog.author_id == current_user.id):
            return forbidden_response('无权删除该文章')

        # 管理员删除他人文章时需要填写原因
        admin_deleting_others = getattr(current_user, 'has_admin_rights', False) and blog.author_id != current_user.id
        reason = None
        if admin_deleting_others:
            data = request.get_json(silent=True) or {}
            reason = (data.get('reason') or '').strip()
            if not reason:
                return error_response('请提供删除原因', 400)
            if len(reason) > 500:
                return error_response('删除原因过长（最多500字）', 400)

        # 执行删除（统一软删除：ignore=True，不物理删除）
        blog_title, blog_author_id = BlogService.delete_blog(blog_id, soft_delete=True)

        # 管理员删除他人文章时通知作者
        if getattr(current_user, 'has_admin_rights', False) and blog_author_id and blog_author_id != current_user.id:
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
                from flask import current_app
                current_app.logger.warning(f"Failed to send delete notification: {e}")

        # 记录管理员操作日志（管理员删除时）
        if getattr(current_user, 'has_admin_rights', False) and blog_author_id and blog_author_id != current_user.id:
            try:
                log_admin_action(
                    action='delete_blog',
                    admin_id=current_user.id,
                    target_user_id=blog_author_id,
                    object_type='blog',
                    object_id=blog_id,
                    reason=reason if (blog_author_id and blog_author_id != current_user.id) else '自删',
                    metadata={'blog_title': blog_title}
                )
            except Exception:
                pass

        return success_response('文章已删除')
