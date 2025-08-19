import markdown
import bleach
from bleach.sanitizer import Cleaner
import pygments

def safe_markdown_to_html(markdown_text):
    """
    将Markdown文本转换为安全的HTML，防止XSS攻击（兼容最新Bleach版本）
    支持 LaTeX 数学公式渲染
    
    参数:
        markdown_text (str): 原始Markdown文本
        
    返回:
        str: 经过安全过滤的HTML内容
    """
    
    # 验证数学公式内容是否安全
    def is_safe_math_content(math_content):
        import re
        
        # 移除数学公式的包装符号
        content = math_content
        if content.startswith('$$') and content.endswith('$$'):
            content = content[2:-2]
        elif content.startswith('$') and content.endswith('$'):
            content = content[1:-1]
        elif content.startswith('\\[') and content.endswith('\\]'):
            content = content[2:-2]
        elif content.startswith('\\(') and content.endswith('\\)'):
            content = content[2:-2]
        
        content = content.strip()
        
        # 检查是否包含HTML标签（但排除LaTeX中的比较符号）
        # 使用完整的HTML标签匹配，必须有开始和结束的尖括号
        # 检查是否有合法的HTML标签结构：<tagname> 或 <tagname/> 或 <tagname 属性>
        import re
        html_tag_pattern = r'<\s*([a-zA-Z][a-zA-Z0-9\-]*)\s*(?:[^>]*)?\s*>'
        matches = re.findall(html_tag_pattern, content)
        if matches:
            # 进一步验证：确保不是数学符号的误匹配
            for match in matches:
                # 检查标签名是否为常见的HTML标签
                common_html_tags = [
                    'div', 'span', 'p', 'a', 'img', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'script', 'style', 'link', 'meta',
                    'input', 'button', 'form', 'iframe', 'object', 'embed'
                ]
                if match.lower() in common_html_tags:
                    return False
        
        # 额外检查：是否包含明显的HTML属性模式
        if re.search(r'<[^>]*\s+(class|id|src|href|onclick|onload|style)\s*=', content, re.IGNORECASE):
            return False
            
        # 检查是否包含JavaScript相关内容
        dangerous_patterns = [
            r'javascript:',
            r'\bon\w+\s*=',  # onclick, onload, etc. (需要单词边界)
            r'<script',
            r'</script',
            r'eval\s*\(',
            r'document\.',
            r'window\.',
            r'alert\s*\(',
            r'prompt\s*\(',
            r'confirm\s*\(',
        ]
        
        for pattern in dangerous_patterns:
            if re.search(pattern, content, re.IGNORECASE):
                return False
        
        # 检查是否包含不安全的协议
        unsafe_protocols = ['javascript:', 'data:', 'vbscript:']
        for protocol in unsafe_protocols:
            if protocol in content.lower():
                return False
                
        return True

    # 保护 LaTeX 数学公式不被 Markdown 处理
    def protect_latex_math(text):
        import re
        
        # 存储受保护的数学公式
        protected_math = {}
        counter = 0
        
        # 保护块级数学公式 $$...$$
        def replace_display_math(match):
            nonlocal counter
            math_content = match.group(0)
            # 预先验证内容是否为合法的数学公式
            if is_safe_math_content(math_content):
                placeholder = f"MATHPROTECTDISPLAY{counter}MATHPROTECT"
                protected_math[placeholder] = math_content
                counter += 1
                return placeholder
            else:
                # 不安全的内容不进行保护，让 Markdown 正常处理
                return math_content
            
        # 保护行内数学公式 $...$
        def replace_inline_math(match):
            nonlocal counter
            math_content = match.group(0)
            # 预先验证内容是否为合法的数学公式
            if is_safe_math_content(math_content):
                placeholder = f"MATHPROTECTINLINE{counter}MATHPROTECT"
                protected_math[placeholder] = math_content
                counter += 1
                return placeholder
            else:
                # 不安全的内容不进行保护，让 Markdown 正常处理
                return math_content
        
        # 保护 \[...\] 和 \(...\) 格式
        def replace_bracket_math(match):
            nonlocal counter
            math_content = match.group(0)
            # 预先验证内容是否为合法的数学公式
            if is_safe_math_content(math_content):
                placeholder = f"MATHPROTECTBRACKET{counter}MATHPROTECT"
                protected_math[placeholder] = math_content
                counter += 1
                return placeholder
            else:
                # 不安全的内容不进行保护，让 Markdown 正常处理
                return math_content
        
        # 先处理块级数学公式（避免与行内公式冲突）
        text = re.sub(r'\$\$.*?\$\$', replace_display_math, text, flags=re.DOTALL)
        
        # 处理 \[...\] 块级公式
        text = re.sub(r'\\\[.*?\\\]', replace_bracket_math, text, flags=re.DOTALL)
        
        # 处理行内数学公式（注意避免匹配到已处理的 $$ 标记）
        text = re.sub(r'(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)', replace_inline_math, text)
        
        # 处理 \(...\) 行内公式
        text = re.sub(r'\\\(.*?\\\)', replace_bracket_math, text, flags=re.DOTALL)
        
        return text, protected_math
    
    # 恢复受保护的数学公式（带安全验证）
    def restore_latex_math(text, protected_math):
        import re
        for placeholder, original in protected_math.items():
            # 验证数学公式内容的安全性
            if is_safe_math_content(original):
                text = text.replace(placeholder, original)
            else:
                # 如果不安全，用安全的占位符替换
                text = text.replace(placeholder, "[数学公式已被过滤]")
        return text
    
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
            
            # 检查是否是无序列表项（* 开头）
            elif re.match(r'^\*\s+', line):
                processed_lines.append(line)
                i += 1
                
                # 查看后续行，寻找子列表和普通内容
                while i < len(lines):
                    next_line = lines[i]
                    
                    # 如果是空行，跳过但继续查找
                    if next_line.strip() == '':
                        i += 1
                        continue
                    
                    # 如果是两个空格缩进的内容（属于当前列表项的内容）
                    elif re.match(r'^  [^\s]', next_line) and not re.match(r'^  \*\s+', next_line):
                        # 这是列表项的继续内容，保持原样
                        processed_lines.append(next_line)
                        i += 1
                    
                    # 如果是两个空格缩进的子列表项
                    elif re.match(r'^  \*\s+', next_line):
                        # 确保有正确的4空格缩进用于子列表
                        processed_lines.append('    ' + next_line.strip())
                        i += 1
                    
                    # 如果遇到新的顶级列表项或其他内容，退出内层循环
                    else:
                        break
            
            else:
                processed_lines.append(line)
                i += 1
        
        return '\n'.join(processed_lines)
    
    # 保护 LaTeX 数学公式
    markdown_text, protected_math = protect_latex_math(markdown_text)
    
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
        'dl', 'dt', 'dd',
        # MathJax 相关标签
        'mjx-container', 'mjx-math', 'mjx-semantics', 'mjx-mrow', 'mjx-mo', 'mjx-mi', 'mjx-mn',
        'mjx-mfrac', 'mjx-num', 'mjx-den', 'mjx-msup', 'mjx-msub', 'mjx-msubsup',
        'mjx-munder', 'mjx-mover', 'mjx-munderover', 'mjx-msqrt', 'mjx-mroot',
        'mjx-mtext', 'mjx-menclose', 'mjx-mtable', 'mjx-mtr', 'mjx-mtd',
        'mjx-mspace', 'mjx-mpadded', 'mjx-mphantom', 'mjx-annotation'
    ]
    
    # 定义属性白名单（包含动态属性检查）
    ALLOWED_ATTRIBUTES = {
        'a': ['href', 'title', 'rel'],
        'img': ['src', 'alt', 'title', 'width', 'height'],
        'code': ['class'],
        'div': ['class', 'style'],
        'span': ['class', 'style'],
        'th': ['align', 'colspan'],
        'td': ['align', 'colspan'],
        'input': ['type', 'name', 'value', 'checked', 'disabled'],
        # MathJax 相关属性
        'mjx-container': ['class', 'style', 'data-formula'],
        'mjx-math': ['class', 'style'],
        'mjx-semantics': ['class'],
        'mjx-mrow': ['class'],
        'mjx-mo': ['class'],
        'mjx-mi': ['class'],
        'mjx-mn': ['class'],
        'mjx-mfrac': ['class'],
        'mjx-num': ['class'],
        'mjx-den': ['class'],
        'mjx-msup': ['class'],
        'mjx-msub': ['class'],
        'mjx-msubsup': ['class'],
        'mjx-munder': ['class'],
        'mjx-mover': ['class'],
        'mjx-munderover': ['class'],
        'mjx-msqrt': ['class'],
        'mjx-mroot': ['class'],
        'mjx-mtext': ['class'],
        'mjx-menclose': ['class'],
        'mjx-mtable': ['class'],
        'mjx-mtr': ['class'],
        'mjx-mtd': ['class'],
        'mjx-mspace': ['class'],
        'mjx-mpadded': ['class'],
        'mjx-mphantom': ['class'],
        'mjx-annotation': ['class']
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
    
    # 净化HTML内容（在占位符状态下清理，避免数学公式被转义）
    clean_html = cleaner.clean(raw_html)
    
    # 最后恢复受保护的 LaTeX 数学公式
    clean_html = restore_latex_math(clean_html, protected_math)
    
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