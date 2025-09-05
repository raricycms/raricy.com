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
from app.web.blog.utils.response_utils import success_response, error_response, validation_error_response, not_found_response


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
    @admin_required
    def delete_blog(blog_id):
        """
        管理员删除文章：删除 Blog、BlogContent、BlogLike，并清理 instance/blogs/<id> 目录。
        """
        from app.models import Blog
        
        blog = Blog.query.get(blog_id)
        if not blog:
            return not_found_response('未找到文章')
        
        # 保存文章信息用于通知
        blog_title, blog_author_id = BlogService.delete_blog(blog_id)
        
        # 发送删除通知给文章作者（如果不是作者自己删除）
        if blog_author_id and blog_author_id != current_user.id:
            try:
                send_notification(
                    recipient_id=blog_author_id,
                    action="文章删除",
                    actor_id=current_user.id,
                    object_type="blog",
                    object_id=blog_id,
                    detail=f"你的文章《{blog_title}》已被管理员删除。如有疑问，请联系管理员。"
                )
            except Exception as e:
                from flask import current_app
                current_app.logger.warning(f"Failed to send delete notification: {e}")
        
        return success_response('文章已删除')
