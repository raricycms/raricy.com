"""
博客用户视图
"""
from flask import render_template, request, abort, jsonify, url_for
from flask_login import login_required, current_user
from app.extensions import turnstile
from app.extensions.decorators import admin_required
from app.service.notifications import send_notification
from app.web.blog.services.blog_service import BlogService
from app.web.blog.validators.blog_validator import BlogValidator
from app.web.blog.utils.ban_check import check_user_ban_status, check_user_ban_status_for_admin
from app.web.blog.utils.response_utils import success_response, error_response, validation_error_response, forbidden_response


def register_views(blog_bp):
    """注册用户视图路由"""
    
    @blog_bp.route('/')
    def menu():
        """
        博客列表页
        
        支持按栏目筛选，URL格式：/blog/?category=栏目slug
        """
        category_slug = request.args.get('category')
        featured = request.args.get('featured')
        featured_flag = None
        if featured is not None:
            featured_flag = True if featured in ['1', 'true', 'True'] else False if featured in ['0', 'false', 'False'] else None
        
        blogs, categories, current_category = BlogService.get_blog_list(category_slug, featured=featured_flag)
        
        if blogs is None:  # 栏目不存在
            abort(404)
        
        return render_template('blog/menu.html', 
                             blogs=blogs, 
                             categories=categories, 
                             current_category=current_category,
                             featured=featured_flag)
    
    @blog_bp.route('/<blog_id>')
    def blog_detail(blog_id):
        """
        博客详情页
        
        - 元信息来自数据库 `Blog`
        - 正文从数据库 `BlogContent` 读取并渲染
        """
        blog_dict, content = BlogService.get_blog_detail(blog_id)
        
        if blog_dict is None:
            abort(404)
        
        return render_template('blog/blog.html', blog=blog_dict, content=content)
    
    @blog_bp.route('/upload_blog', methods=['GET', 'POST'])
    @login_required
    def upload():
        """
        上传新博客
        
        - 将元信息写入数据库 `Blog`
        - 正文写入数据库 `BlogContent`
        """
        if request.method == 'GET':
            # 检查用户是否被禁言
            is_banned, ban_info, _ = check_user_ban_status()
            
            # 获取栏目列表用于下拉选择
            from app.models import Category
            categories = Category.get_hierarchy()
            return render_template('blog/upload_blog.html', categories=categories, ban_info=ban_info)
        
        elif request.method == 'POST':
            # 检查用户是否被禁言
            is_banned, _, error_response = check_user_ban_status()
            if is_banned:
                return error_response
            
            data = request.get_json()
            
            # 验证博客数据
            is_valid, error_message, validated_data = BlogValidator.validate_blog_data(data)
            if not is_valid:
                return validation_error_response(error_message)
            
            # Turnstile 人机验证（可选）
            from flask import current_app
            if current_app.config['TURNSTILE_AVAILABLE'] and not turnstile.verify(data.get('cf-turnstile-response')):
                return error_response('人机验证失败', 400)
            
            # 创建博客
            blog_id = BlogService.create_blog(validated_data)
            
            return success_response('上传成功', blog_id=blog_id)
    
    @blog_bp.route('/<blog_id>/edit', methods=['GET', 'POST'])
    @login_required
    def edit_blog(blog_id):
        """
        文章编辑：作者与管理员可以编辑标题、摘要与正文（Markdown）。
        
        - GET: 渲染编辑页
        - POST: 保存更新，返回 JSON
        """
        from app.models import Blog
        
        blog = Blog.query.get(blog_id)
        if not blog or blog.ignore:
            abort(404)
        
        # 权限：作者或管理员
        if not (current_user.is_admin or blog.author_id == current_user.id):
            return forbidden_response('无权编辑该文章')
        
        # 检查用户是否被禁言（管理员除外）
        is_banned, _, error_response = check_user_ban_status_for_admin()
        if is_banned:
            return error_response
        
        if request.method == 'GET':
            # 检查用户是否被禁言（管理员除外）
            is_banned, ban_info, _ = check_user_ban_status_for_admin()
            
            blog_dict, markdown_content, categories = BlogService.get_blog_for_edit(blog_id)
            if blog_dict is None:
                abort(404)
            
            return render_template('blog/edit_blog.html', 
                                 blog=blog_dict, 
                                 content_markdown=markdown_content, 
                                 categories=categories, 
                                 ban_info=ban_info)
        
        # POST: 保存
        data = request.get_json(silent=True) or {}
        
        # 验证博客数据
        is_valid, error_message, validated_data = BlogValidator.validate_blog_data(data)
        if not is_valid:
            return validation_error_response(error_message)
        
        # Turnstile 人机验证（可选）
        from flask import current_app
        if current_app.config.get('TURNSTILE_AVAILABLE'):
            if not turnstile.verify(data.get('cf-turnstile-response')):
                return error_response('人机验证失败', 400)
        
        # 更新博客
        has_changes, changes_detail = BlogService.update_blog(blog_id, validated_data)
        
        # 发送编辑通知给文章作者（如果是管理员编辑且不是作者本人）
        if has_changes and current_user.is_admin and blog.author_id != current_user.id:
            try:
                changes_text = "、".join(changes_detail) if changes_detail else "文章内容已更新"
                send_notification(
                    recipient_id=blog.author_id,
                    action="文章编辑",
                    actor_id=current_user.id,
                    object_type="blog",
                    object_id=blog_id,
                    detail=f"你的文章《{validated_data['title']}》已被管理员编辑。修改内容：{changes_text}"
                )
            except Exception as e:
                from flask import current_app
                current_app.logger.warning(f"Failed to send edit notification: {e}")
        
        return success_response('更新成功', 
                              blog_id=blog_id, 
                              redirect=url_for('blog.blog_detail', blog_id=blog_id))
