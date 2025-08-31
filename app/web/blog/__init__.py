from flask import Blueprint, render_template, current_app, abort, request, jsonify, url_for
from flask_login import login_required, current_user
from app.extensions import db, turnstile
from app.models import Blog, BlogContent, BlogLike, Category
from app.extensions.decorators import admin_required
from app.service.notifications import send_notification
import os
import uuid
from datetime import datetime
from app.utils.process_markdown import safe_markdown_to_html
import shutil

blog_bp = Blueprint('blog', __name__)

@blog_bp.route('/')
def menu():
    """
    博客列表页

    支持按栏目筛选，URL格式：/blog/?category=栏目slug
    """
    category_slug = request.args.get('category')
    current_category = None
    
    # 获取栏目层级结构用于导航
    categories = Category.get_hierarchy()
    
    # 构建查询
    query = Blog.query.filter_by(ignore=False)
    
    if category_slug:
        # 按栏目筛选
        current_category = Category.query.filter_by(slug=category_slug, is_active=True).first()
        if current_category:
            if current_category.parent_id is None:
                # 一级栏目：包含该栏目下的所有文章（包括子栏目）
                child_ids = [child.id for child in current_category.children.filter_by(is_active=True).all()]
                category_ids = [current_category.id] + child_ids
                query = query.filter(Blog.category_id.in_(category_ids))
            else:
                # 二级栏目：只显示该栏目的文章
                query = query.filter_by(category_id=current_category.id)
        else:
            # 栏目不存在，返回404
            abort(404)
    
    blogs = []
    for blog in query.order_by(Blog.created_at.desc()).all():
        item = blog.to_dict()
        blogs.append(item)
    
    return render_template('blog/menu.html', 
                         blogs=blogs, 
                         categories=categories, 
                         current_category=current_category)

@blog_bp.route('/<blog_id>')
def blog_detail(blog_id):
    """
    博客详情页

    - 元信息来自数据库 `Blog`
    - 正文从数据库 `BlogContent` 读取并渲染
    """
    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        abort(404)

    # 从数据库读取正文
    content_obj = BlogContent.query.get(blog_id)
    content = content_obj.content if content_obj else ''

    blog_dict = blog.to_dict()
    blog_dict['content'] = safe_markdown_to_html(content)
    # 当前用户是否已点赞
    liked = False
    try:
        if current_user.is_authenticated:
            liked = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first() is not None
    except Exception:
        liked = False
    blog_dict['liked'] = liked
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
        ban_info = None
        if current_user.is_currently_banned():
            ban_info = current_user.get_ban_info()
        
        # 获取栏目列表用于下拉选择
        categories = Category.get_hierarchy()
        return render_template('blog/upload_blog.html', categories=categories, ban_info=ban_info)
    elif request.method == 'POST':
        # 检查用户是否被禁言
        if current_user.is_currently_banned():
            ban_info = current_user.get_ban_info()
            remaining_text = ""
            if ban_info and ban_info.get('remaining_hours'):
                remaining_hours = ban_info['remaining_hours']
                if remaining_hours > 24:
                    remaining_text = f"剩余约{remaining_hours/24:.1f}天"
                else:
                    remaining_text = f"剩余约{remaining_hours:.1f}小时"
            return jsonify({
                'code': 403, 
                'message': f'您已被禁言，无法发布博客。{remaining_text}。原因：{ban_info.get("reason", "未说明") if ban_info else "未说明"}'
            }), 403
            
        data = request.get_json()
        if not data or not data.get('title') or not data.get('content') or not data.get('description'):
            return jsonify({'code': 400, 'message': '缺少必要参数'}), 400

        # Turnstile 人机验证（可选）
        if current_app.config['TURNSTILE_AVAILABLE'] and not turnstile.verify(data.get('cf-turnstile-response')):
            print("Turnstile verification failed. Reason:", data.get('cf-turnstile-response'))
            return jsonify({'code': 400, 'message': '人机验证失败'}), 400

        # 基本校验
        if len(data['title']) > 30:
            return jsonify({'code': 400, 'message': '标题不能超过30个字符'}), 400
        if len(data['description']) > 100:
            return jsonify({'code': 400, 'message': '描述不能超过100个字符'}), 400
        if len(data['content']) > 200000:
            return jsonify({'code': 400, 'message': '内容不能超过200000个字符'}), 400

        # 栏目验证
        category_id = data.get('category_id')
        if category_id:
            try:
                category_id = int(category_id)
                category = Category.query.filter_by(id=category_id, is_active=True).first()
                if not category:
                    return jsonify({'code': 400, 'message': '选择的栏目不存在'}), 400
            except (ValueError, TypeError):
                return jsonify({'code': 400, 'message': '栏目ID格式错误'}), 400
        else:
            category_id = None

        # 生成博客 ID，并准备目录
        blog_id = str(uuid.uuid4())
        # 若历史上仍需要创建目录以便放图片等资源，可保留目录；否则可以完全省略
        blog_path = os.path.join(current_app.instance_path, "blogs", blog_id)
        os.makedirs(blog_path, exist_ok=True)

        # 写入数据库（元信息）
        blog = Blog(
            id=blog_id,
            title=data['title'],
            description=data['description'],
            author_id=current_user.id,
            category_id=category_id,
            created_at=datetime.now(),
        )
        db.session.add(blog)
        # 正文保存到 BlogContent（与 Blog 同事务提交）
        content_obj = BlogContent(blog_id=blog_id, content=data['content'])
        db.session.add(content_obj)
        db.session.commit()

        return jsonify({'code': 200, 'message': '上传成功', 'blog_id': blog_id})
        

@blog_bp.route('/<blog_id>/like', methods=['POST'])
@login_required
def like_toggle(blog_id):
    """
    点赞/取消点赞切换接口。

    返回：{ code, liked, likes_count }
    """
    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    like = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first()
    if like:
        # 取消点赞
        db.session.delete(like)
        blog.likes_count = max(0, (blog.likes_count or 0) - 1)
        liked = False
    else:
        # 点赞
        like = BlogLike(blog_id=blog_id, user_id=current_user.id)
        db.session.add(like)
        blog.likes_count = (blog.likes_count or 0) + 1
        liked = True
        
        # 发送点赞通知给文章作者（但不给自己发）
        if blog.author_id != current_user.id:
            try:
                send_notification(
                    recipient_id=blog.author_id,
                    action="文章点赞",
                    actor_id=current_user.id,
                    object_type="blog",
                    object_id=blog_id,
                    detail=f"你的文章《{blog.title}》收到了一个新的点赞！"
                )
            except Exception as e:
                # 通知发送失败不影响点赞功能
                current_app.logger.warning(f"Failed to send like notification: {e}")

    db.session.commit()
    return jsonify({'code': 200, 'liked': liked, 'likes_count': blog.likes_count})


@blog_bp.route('/<blog_id>/likers', methods=['GET'])
@login_required
@admin_required
def likers(blog_id):
    """
    管理员查看点赞者列表。
    支持简单分页参数：?offset=0&limit=50
    """
    blog = Blog.query.get(blog_id)
    if not blog:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    try:
        offset = int(request.args.get('offset', 0))
        limit = int(request.args.get('limit', 50))
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
    except Exception:
        offset, limit = 0, 50

    q = BlogLike.query.filter_by(blog_id=blog_id).order_by(BlogLike.created_at.desc())
    total = q.count()
    likes = q.offset(offset).limit(limit).all()

    users = []
    for like in likes:
        user = like.user
        users.append({
            'id': user.id if user else like.user_id,
            'username': user.username if user else None,
            'avatar_url': url_for('auth.get_avatar', user_id=(user.id if user else like.user_id)),
            'liked_at': like.created_at.strftime('%Y-%m-%d %H:%M:%S') if like.created_at else None,
        })

    return jsonify({'code': 200, 'total': total, 'offset': offset, 'limit': limit, 'users': users})


@blog_bp.route('/<blog_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_blog(blog_id):
    """
    管理员删除文章：删除 Blog、BlogContent、BlogLike，并清理 instance/blogs/<id> 目录。
    """
    blog = Blog.query.get(blog_id)
    if not blog:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    # 保存文章信息用于通知
    blog_title = blog.title
    blog_author_id = blog.author_id
    
    # 发送删除通知给文章作者（如果不是作者自己删除）
    if blog_author_id != current_user.id:
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
            current_app.logger.warning(f"Failed to send delete notification: {e}")

    # 删除磁盘目录（若存在）
    blog_path = os.path.join(current_app.instance_path, 'blogs', blog_id)
    try:
        shutil.rmtree(blog_path, ignore_errors=True)
    except Exception:
        # 忽略清理错误，继续逻辑删除
        pass

    db.session.delete(blog)
    db.session.commit()
    return jsonify({'code': 200, 'message': '文章已删除'})


@blog_bp.route('/<blog_id>/edit', methods=['GET', 'POST'])
@login_required
def edit_blog(blog_id):
    """
    文章编辑：作者与管理员可以编辑标题、摘要与正文（Markdown）。

    - GET: 渲染编辑页
    - POST: 保存更新，返回 JSON
    """
    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        abort(404)

    # 权限：作者或管理员
    if not (current_user.is_admin or blog.author_id == current_user.id):
        return jsonify({'code': 403, 'message': '无权编辑该文章'}), 403

    # 检查用户是否被禁言（管理员除外）
    if not current_user.is_admin and current_user.is_currently_banned():
        ban_info = current_user.get_ban_info()
        remaining_text = ""
        if ban_info and ban_info.get('remaining_hours'):
            remaining_hours = ban_info['remaining_hours']
            if remaining_hours > 24:
                remaining_text = f"剩余约{remaining_hours/24:.1f}天"
            else:
                remaining_text = f"剩余约{remaining_hours:.1f}小时"
        return jsonify({
            'code': 403, 
            'message': f'您已被禁言，无法编辑博客。{remaining_text}。原因：{ban_info.get("reason", "未说明") if ban_info else "未说明"}'
        }), 403

    if request.method == 'GET':
        # 检查用户是否被禁言（管理员除外）
        ban_info = None
        if not current_user.is_admin and current_user.is_currently_banned():
            ban_info = current_user.get_ban_info()
            
        # 读取 Markdown 正文
        content_obj = BlogContent.query.get(blog_id)
        markdown_content = content_obj.content if content_obj else ''
        blog_dict = blog.to_dict()
        # 获取栏目列表用于下拉选择
        categories = Category.get_hierarchy()
        return render_template('blog/edit_blog.html', blog=blog_dict, content_markdown=markdown_content, categories=categories, ban_info=ban_info)

    # POST: 保存
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    description = (data.get('description') or '').strip()
    content = data.get('content') or ''

    # Turnstile 人机验证（可选）
    if current_app.config.get('TURNSTILE_AVAILABLE'):
        if not turnstile.verify(data.get('cf-turnstile-response')):
            return jsonify({'code': 400, 'message': '人机验证失败'}), 400

    # 校验
    if not title or not description or not content:
        return jsonify({'code': 400, 'message': '缺少必要参数'}), 400
    if len(title) > 30:
        return jsonify({'code': 400, 'message': '标题不能超过30个字符'}), 400
    if len(description) > 100:
        return jsonify({'code': 400, 'message': '描述不能超过100个字符'}), 400
    if len(content) > 200000:
        return jsonify({'code': 400, 'message': '内容不能超过200000个字符'}), 400

    # 栏目验证
    category_id = data.get('category_id')
    if category_id:
        try:
            category_id = int(category_id)
            category = Category.query.filter_by(id=category_id, is_active=True).first()
            if not category:
                return jsonify({'code': 400, 'message': '选择的栏目不存在'}), 400
        except (ValueError, TypeError):
            return jsonify({'code': 400, 'message': '栏目ID格式错误'}), 400
    else:
        category_id = None

    # 检查是否有实际的修改
    has_changes = False
    changes_detail = []
    
    if blog.title != title:
        changes_detail.append(f"标题从《{blog.title}》改为《{title}》")
        has_changes = True
    
    if blog.description != description:
        changes_detail.append("摘要已更新")
        has_changes = True
    
    # 检查栏目变化
    old_category_name = blog.category.name if blog.category else "未分类"
    new_category_name = "未分类"
    if category_id:
        new_category = Category.query.get(category_id)
        if new_category:
            new_category_name = new_category.name
    
    if blog.category_id != category_id:
        changes_detail.append(f"栏目从《{old_category_name}》改为《{new_category_name}》")
        has_changes = True
    
    # 检查内容变化
    content_obj = BlogContent.query.get(blog_id)
    old_content = content_obj.content if content_obj else ''
    if old_content != content:
        changes_detail.append("文章内容已更新")
        has_changes = True

    # 更新 Blog 元信息
    blog.title = title
    blog.description = description
    blog.category_id = category_id

    # 更新/创建正文 Markdown
    if not content_obj:
        content_obj = BlogContent(blog_id=blog_id, content=content)
        db.session.add(content_obj)
    else:
        content_obj.content = content

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
                detail=f"你的文章《{title}》已被管理员编辑。修改内容：{changes_text}"
            )
        except Exception as e:
            current_app.logger.warning(f"Failed to send edit notification: {e}")

    db.session.commit()

    return jsonify({'code': 200, 'message': '更新成功', 'blog_id': blog_id, 'redirect': url_for('blog.blog_detail', blog_id=blog_id)})


@blog_bp.route('/admin/categories')
@login_required
@admin_required
def manage_categories():
    """
    栏目管理页面（仅管理员）
    """
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
    
    name = (data.get('name') or '').strip()
    slug = (data.get('slug') or '').strip()
    description = (data.get('description') or '').strip()
    icon = (data.get('icon') or '').strip()
    parent_id = data.get('parent_id')
    
    if not name or not slug:
        return jsonify({'code': 400, 'message': '栏目名称和标识符不能为空'}), 400
    
    # 检查slug是否已存在
    existing = Category.query.filter_by(slug=slug).first()
    if existing:
        return jsonify({'code': 400, 'message': '标识符已存在'}), 400
    
    # 验证父栏目
    if parent_id:
        try:
            parent_id = int(parent_id)
            parent = Category.query.filter_by(id=parent_id, parent_id=None, is_active=True).first()
            if not parent:
                return jsonify({'code': 400, 'message': '父栏目不存在或不是一级栏目'}), 400
        except (ValueError, TypeError):
            return jsonify({'code': 400, 'message': '父栏目ID格式错误'}), 400
    else:
        parent_id = None
    
    # 创建栏目
    category = Category(
        name=name,
        slug=slug,
        description=description,
        icon=icon,
        parent_id=parent_id,
        sort_order=0,  # 可以后续调整
        is_active=True,
        created_at=datetime.now()
    )
    
    db.session.add(category)
    db.session.commit()
    
    return jsonify({'code': 200, 'message': '栏目创建成功', 'category': category.to_dict()})


@blog_bp.route('/admin/categories/<int:category_id>', methods=['PUT'])
@login_required
@admin_required
def update_category(category_id):
    """
    更新栏目信息（仅管理员）
    """
    category = Category.query.get(category_id)
    if not category:
        return jsonify({'code': 404, 'message': '栏目不存在'}), 404
    
    data = request.get_json()
    
    name = (data.get('name') or '').strip()
    slug = (data.get('slug') or '').strip()
    description = (data.get('description') or '').strip()
    icon = (data.get('icon') or '').strip()
    is_active = data.get('is_active', True)
    
    if not name or not slug:
        return jsonify({'code': 400, 'message': '栏目名称和标识符不能为空'}), 400
    
    # 检查slug是否被其他栏目使用
    existing = Category.query.filter(Category.slug == slug, Category.id != category_id).first()
    if existing:
        return jsonify({'code': 400, 'message': '标识符已被其他栏目使用'}), 400
    
    # 更新栏目信息
    category.name = name
    category.slug = slug
    category.description = description
    category.icon = icon
    category.is_active = is_active
    
    db.session.commit()
    
    return jsonify({'code': 200, 'message': '栏目更新成功', 'category': category.to_dict()})


@blog_bp.route('/admin/categories/<int:category_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_category(category_id):
    """
    删除栏目（仅管理员）
    
    注意：删除栏目前需要先将该栏目下的文章移动到其他栏目或设为未分类
    """
    category = Category.query.get(category_id)
    if not category:
        return jsonify({'code': 404, 'message': '栏目不存在'}), 404
    
    # 检查是否有文章在此栏目下
    blog_count = Blog.query.filter_by(category_id=category_id).count()
    if blog_count > 0:
        return jsonify({'code': 400, 'message': f'无法删除，该栏目下还有 {blog_count} 篇文章'}), 400
    
    # 检查是否有子栏目
    child_count = Category.query.filter_by(parent_id=category_id).count()
    if child_count > 0:
        return jsonify({'code': 400, 'message': f'无法删除，该栏目下还有 {child_count} 个子栏目'}), 400
    
    db.session.delete(category)
    db.session.commit()
    
    return jsonify({'code': 200, 'message': '栏目删除成功'})


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
    per_page = 20
    
    # 构建查询
    query = Blog.query.filter_by(ignore=False)
    
    # 按栏目筛选
    if category_id == -1:  # 未分类
        query = query.filter_by(category_id=None)
    elif category_id:
        query = query.filter_by(category_id=category_id)
    
    # 搜索标题
    if search:
        query = query.filter(Blog.title.contains(search))
    
    # 分页
    pagination = query.order_by(Blog.created_at.desc()).paginate(
        page=page, per_page=per_page, error_out=False
    )
    
    articles = pagination.items
    categories = Category.get_hierarchy()
    
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
    blog = Blog.query.get(blog_id)
    if not blog:
        return jsonify({'code': 404, 'message': '文章不存在'}), 404
    
    data = request.get_json()
    category_id = data.get('category_id')
    
    # 验证栏目
    if category_id:
        try:
            category_id = int(category_id)
            category = Category.query.filter_by(id=category_id, is_active=True).first()
            if not category:
                return jsonify({'code': 400, 'message': '选择的栏目不存在'}), 400
        except (ValueError, TypeError):
            return jsonify({'code': 400, 'message': '栏目ID格式错误'}), 400
    else:
        category_id = None
    
    # 更新栏目
    old_category = blog.category.name if blog.category else '未分类'
    blog.category_id = category_id
    db.session.commit()
    
    new_category = blog.category.name if blog.category else '未分类'
    
    return jsonify({
        'code': 200, 
        'message': f'文章栏目已从 "{old_category}" 更改为 "{new_category}"',
        'blog': blog.to_dict()
    })


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
    
    if not blog_ids:
        return jsonify({'code': 400, 'message': '请选择要更新的文章'}), 400
    
    # 验证栏目
    if category_id:
        try:
            category_id = int(category_id)
            category = Category.query.filter_by(id=category_id, is_active=True).first()
            if not category:
                return jsonify({'code': 400, 'message': '选择的栏目不存在'}), 400
        except (ValueError, TypeError):
            return jsonify({'code': 400, 'message': '栏目ID格式错误'}), 400
    else:
        category_id = None
    
    # 批量更新
    updated_count = Blog.query.filter(Blog.id.in_(blog_ids)).update(
        {Blog.category_id: category_id}, synchronize_session=False
    )
    db.session.commit()
    
    category_name = category.name if category_id else '未分类'
    
    return jsonify({
        'code': 200, 
        'message': f'已将 {updated_count} 篇文章分配到 "{category_name}"'
    })


@blog_bp.route('/admin')
@login_required
@admin_required
def admin_dashboard():
    """
    博客管理后台首页（仅管理员）
    """
    # 统计数据
    total_blogs = Blog.query.filter_by(ignore=False).count()
    categorized_blogs = Blog.query.filter(Blog.category_id.isnot(None), Blog.ignore == False).count()
    uncategorized_blogs = Blog.query.filter_by(category_id=None, ignore=False).count()
    total_categories = Category.query.filter_by(is_active=True).count()
    total_likes = db.session.query(db.func.sum(Blog.likes_count)).scalar() or 0
    
    # 最近文章
    recent_blogs = Blog.query.filter_by(ignore=False).order_by(Blog.created_at.desc()).limit(5).all()
    
    # 热门文章（按点赞数）
    popular_blogs = Blog.query.filter_by(ignore=False).order_by(Blog.likes_count.desc()).limit(5).all()
    
    # 栏目文章分布
    category_stats = db.session.query(
        Category.name, 
        Category.icon,
        db.func.count(Blog.id).label('blog_count')
    ).outerjoin(Blog, Category.id == Blog.category_id).filter(
        Category.is_active == True,
        Blog.ignore == False
    ).group_by(Category.id, Category.name, Category.icon).all()
    
    stats = {
        'total_blogs': total_blogs,
        'categorized_blogs': categorized_blogs,
        'uncategorized_blogs': uncategorized_blogs,
        'total_categories': total_categories,
        'total_likes': total_likes,
        'recent_blogs': [blog.to_dict() for blog in recent_blogs],
        'popular_blogs': [blog.to_dict() for blog in popular_blogs],
        'category_stats': [{'name': stat[0], 'icon': stat[1], 'count': stat[2]} for stat in category_stats]
    }
    
    return render_template('blog/admin_dashboard.html', stats=stats)