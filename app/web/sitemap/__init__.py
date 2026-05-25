from flask import Blueprint, render_template
from app.extensions import sitemap

sitemap_bp = Blueprint('sitemap', __name__, url_prefix='/sitemap')

@sitemap.register_generator
def static_pages():
    yield 'home.index', {}
    yield 'story.root_collection', {}
    yield 'blog.menu', {}

@sitemap.register_generator
def story_pages():
    from app.web.story.services import StoryService
    for kind, *args in StoryService.walk_all():
        if kind == 'collection':
            rel_path = args[0]
            if rel_path:
                yield 'story.resolve_path', {'path': rel_path}
            # root is already covered by story.root_collection above
        elif kind == 'story':
            parent_path, story_id = args
            full = f"{parent_path}/{story_id}" if parent_path else story_id
            yield 'story.resolve_path', {'path': full}


@sitemap_bp.route('/')
def index():
    """sitemap索引页面"""
    return render_template('sitemap/index.html')

@sitemap_bp.route('/sitemap.xml')
def xml():
    """生成sitemap.xml"""
    return sitemap.sitemap()
