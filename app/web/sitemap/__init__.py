from flask import Blueprint, render_template, current_app
from app.extensions import sitemap

sitemap_bp = Blueprint('sitemap', __name__, url_prefix='/sitemap')

# 注册sitemap生成器
@sitemap.register_generator
def static_pages():
    """静态页面"""
    # 主页
    yield 'home.index', {}
    
    # 游戏页面
    yield 'game.menu', {}
    yield 'game.quandi', {}
    yield 'game.xingkong', {}
    yield 'game.reversi', {}
    yield 'game.gecao', {}
    
    # 故事页面
    yield 'story.menu', {}
    
    # 博客页面
    yield 'blog.menu', {}

@sitemap.register_generator
def story_pages():
    """动态故事页面"""
    import os
    import json
    
    batch_dir = os.path.join(current_app.instance_path, 'stories')
    for batch_id in os.listdir(batch_dir):
        if not os.path.isdir(os.path.join(batch_dir, batch_id)):
            continue
        story_dir = os.path.join(batch_dir, batch_id)
        info_file = os.path.join(story_dir, 'info.json')
        if not os.path.isfile(info_file):
            continue
        yield 'story.batch_detail', {'batch_id': batch_id}
        for story_id in os.listdir(story_dir):
            if not story_id.endswith('.md'):
                continue
            story_id = story_id[:-3]
            yield 'story.story_detail', {'batch_id': batch_id, 'story_id': story_id}

@sitemap_bp.route('/')
def index():
    """sitemap索引页面"""
    return render_template('sitemap/index.html')

@sitemap_bp.route('/sitemap.xml')
def xml():
    """生成sitemap.xml"""
    return sitemap.sitemap()

