import markdown
import bleach
from bleach.sanitizer import Cleaner
import pygments

def safe_markdown_to_html(markdown_text):
    """
    将Markdown文本转换为安全的HTML，防止XSS攻击（兼容最新Bleach版本）
    
    参数:
        markdown_text (str): 原始Markdown文本
        
    返回:
        str: 经过安全过滤的HTML内容
    """
    # 定义安全标签白名单
    ALLOWED_TAGS = [
        'p', 'br', 'hr', 'pre', 'div', 'span',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'strong', 'b', 'em', 'i', 'u', 's', 
        'code', 'blockquote', 'ul', 'ol', 'li',
        'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td','del', 'input',
        'details', 'summary', 'sub', 'sup', 'mark', 'figure', 'figcaption',
        'dl', 'dt', 'dd'
    ]
    
    # 定义属性白名单（包含动态属性检查）
    ALLOWED_ATTRIBUTES = {
        'a': ['href', 'title', 'rel'],
        'img': ['src', 'alt', 'title', 'width', 'height'],
        'code': ['class'],
        'div': ['class'],
        'span': ['class'],
        'th': ['align', 'colspan'],
        'td': ['align', 'colspan'],
        'input': ['type', 'name', 'value', 'checked', 'disabled']
    }
    
    # 安全协议白名单
    ALLOWED_PROTOCOLS = ['http', 'https', 'mailto', 'tel', 'data']
    
    # 创建自定义的Cleaner实例
    cleaner = Cleaner(
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        strip_comments=True,
        strip=True,
        # 不再使用filters参数
    )
    
    # 添加rel="noopener"的回调函数
    def rel_noopener(attrs, new=False):
        href_key = (None, 'href')
        if href_key in attrs and attrs[href_key].startswith(('http:', 'https:')):
            # 保留现有rel属性并添加安全属性
            existing_rel = attrs.get((None, 'rel'), '').split()
            new_rel = set(existing_rel) | {'noopener', 'noreferrer'}
            attrs[(None, 'rel')] = ' '.join(new_rel)
        return attrs
    
    # 将Markdown转换为HTML
    raw_html = markdown.markdown(markdown_text, extensions=[
        "extra", 
        "codehilite", 
        "tables", 
        "toc",
        "pymdownx.tilde",
        "pymdownx.caret",
        "pymdownx.tasklist"
    ], extension_configs={
        'codehilite': {
            'css_class': 'highlight',
            'use_pygments': True,
            'noclasses': False,
            'linenums': False
        },
        'pymdownx.tilde': {
            'smart_delete': False
        }
    })
    
    # 净化HTML内容
    clean_html = cleaner.clean(raw_html)
    
    # 安全处理链接（自动转换文本链接并添加安全属性）
    final_html = bleach.linkify(
        clean_html,
        callbacks=[
            bleach.callbacks.nofollow,  # 添加rel="nofollow"
            rel_noopener,               # 添加rel="noopener noreferrer"
            # 添加协议安全检查回调
            lambda attrs, new: check_protocol_safety(attrs, ALLOWED_PROTOCOLS),
            # 添加图片src检查回调
            lambda attrs, new: check_image_src(attrs)
        ],
        skip_tags=['pre', 'code']      # 跳过代码块内的文本
    )
    
    return final_html

# 协议安全检查函数
def check_protocol_safety(attrs, allowed_protocols):
    href_key = (None, 'href')
    if href_key in attrs:
        value = attrs[href_key]
        
        # 允许相对路径
        if value.startswith(('/')):
            return attrs
        
        # 检查协议是否在白名单中
        if ':' in value:
            protocol = value.split(':', 1)[0].lower()
            if protocol not in allowed_protocols:
                # 删除不安全的链接
                del attrs[href_key]
        
    return attrs

def check_image_src(attrs):
    # 添加域名白名单
    ALLOWED_IMAGE_DOMAINS = [
        'raricy.com',
        'www.raricy.com',
        'localhost',
        '127.0.0.1',
    ]
    if (None, 'src') in attrs:
        src = attrs[(None, 'src')]
        
        # 解析域名
        from urllib.parse import urlparse
        parsed = urlparse(src)
        
        # 允许data URI和相对路径
        if src.startswith('data:') or not parsed.netloc:
            return attrs
        
        # 检查域名是否在白名单
        if parsed.netloc not in ALLOWED_IMAGE_DOMAINS:
            del attrs[(None, 'src')]
    
    return attrs