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
    # 预处理markdown文本以改善嵌套列表的解析
    def preprocess_markdown(text):
        import re
        lines = text.split('\n')
        processed_lines = []
        i = 0
        
        while i < len(lines):
            line = lines[i]
            
            # 检查是否是有序列表项
            if re.match(r'^\d+\.\s+', line):
                processed_lines.append(line)
                i += 1
                
                # 查看后续行，寻找子列表
                while i < len(lines):
                    next_line = lines[i]
                    
                    # 如果是空行，跳过但继续查找子列表
                    if next_line.strip() == '':
                        i += 1
                        continue
                    
                    # 如果是缩进的无序列表项（子列表）
                    elif re.match(r'^   -\s+', next_line):
                        # 确保有正确的4空格缩进用于子列表
                        processed_lines.append('    ' + next_line.strip())
                        i += 1
                    
                    # 如果遇到新的有序列表项或其他内容，退出内层循环
                    else:
                        break
            else:
                processed_lines.append(line)
                i += 1
        
        return '\n'.join(processed_lines)
    
    # 预处理文本
    markdown_text = preprocess_markdown(markdown_text)
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
    
    # 直接返回清理后的HTML
    # 注意：原先在此处使用了 bleach.linkify 进行自动链接处理，但会导致实体再次转义，
    # 例如代码块中的引号 " 被序列化为 &quot; 后再次被转义为 &amp;quot;，从而在前端显示为 &quot;。
    # 因此这里改为直接返回 clean_html 以避免双重转义问题。
    return clean_html

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