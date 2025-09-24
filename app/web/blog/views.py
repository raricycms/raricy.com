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
            # 仅核心用户可以访问发布页
            if not getattr(current_user, 'authenticated', False):
                abort(403)
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
            
            # 仅核心用户可以发布
            if not getattr(current_user, 'authenticated', False):
                return forbidden_response('只有核心用户才能发布文章')
            
            data = request.get_json()
            
            # 验证博客数据
            is_valid, error_message, validated_data = BlogValidator.validate_blog_data(data)
            if not is_valid:
                return validation_error_response(error_message)
            
            # 每日发文数量限制（最多5篇）
            from datetime import datetime
            from app.models import Blog
            start_of_day = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            today_count = Blog.query.filter(
                Blog.author_id == current_user.id,
                Blog.created_at >= start_of_day
            ).count()
            if today_count >= 5:
                return error_response('今日发布数量已达上限（5篇）', 429)
            
            # 创建博客
            # 若选择了栏目，检查该栏目及其父栏目是否限制管理员专属
            from app.models import Category, User
            category_id = validated_data.get('category_id')
            if category_id:
                category = Category.query.get(category_id)
                if category:
                    parent = category.parent
                    admin_only_effective = bool(getattr(category, 'admin_only_posting', False) or getattr(parent, 'admin_only_posting', False)) if parent else bool(getattr(category, 'admin_only_posting', False))
                else:
                    admin_only_effective = False
                if admin_only_effective and not current_user.is_admin:
                    return forbidden_response('该栏目仅允许管理员发布文章')

            blog_id = BlogService.create_blog(validated_data)

            # 如果该栏目需要通知管理员，向所有管理员发送通知
            if category_id:
                category = category or Category.query.get(category_id)
                parent = category.parent if category else None
                notify_effective = False
                if category:
                    notify_effective = bool(getattr(category, 'notify_admin_on_post', False))
                    if parent:
                        notify_effective = notify_effective or bool(getattr(parent, 'notify_admin_on_post', False))
                if notify_effective:
                    admins = User.query.filter_by(is_admin=True).all()
                    for admin in admins:
                        # 跳过自己
                        if admin.id == current_user.id:
                            continue
                        try:
                            send_notification(
                                recipient_id=admin.id,
                                action='栏目发文提醒',
                                actor_id=current_user.id,
                                object_type='blog',
                                object_id=blog_id,
                                detail=f'用户 {current_user.username} 在栏目 "{category.get_full_path()}" 发布了新文章：{validated_data["title"]}'
                            )
                        except Exception:
                            pass
            
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
