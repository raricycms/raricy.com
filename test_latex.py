#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

# 模拟简化的测试环境
import re
import markdown
from bleach.sanitizer import Cleaner

def protect_latex_math(text):
    import re
    
    # 存储受保护的数学公式
    protected_math = {}
    counter = 0
    
    # 保护块级数学公式 $$...$$
    def replace_display_math(match):
        nonlocal counter
        placeholder = f"MATHPROTECTDISPLAY{counter}MATHPROTECT"
        protected_math[placeholder] = match.group(0)
        counter += 1
        return placeholder
        
    # 保护行内数学公式 $...$
    def replace_inline_math(match):
        nonlocal counter
        placeholder = f"MATHPROTECTINLINE{counter}MATHPROTECT"
        protected_math[placeholder] = match.group(0)
        counter += 1
        return placeholder
    
    # 保护 \[...\] 和 \(...\) 格式
    def replace_bracket_math(match):
        nonlocal counter
        placeholder = f"MATHPROTECTBRACKET{counter}MATHPROTECT"
        protected_math[placeholder] = match.group(0)
        counter += 1
        return placeholder
    
    # 先处理块级数学公式（避免与行内公式冲突）
    text = re.sub(r'\$\$.*?\$\$', replace_display_math, text, flags=re.DOTALL)
    
    # 处理 \[...\] 块级公式
    text = re.sub(r'\\\[.*?\\\]', replace_bracket_math, text, flags=re.DOTALL)
    
    # 处理行内数学公式（注意避免匹配到已处理的 $$ 标记）
    text = re.sub(r'(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)', replace_inline_math, text)
    
    # 处理 \(...\) 行内公式
    text = re.sub(r'\\\(.*?\\\)', replace_bracket_math, text, flags=re.DOTALL)
    
    return text, protected_math

# 恢复受保护的数学公式
def restore_latex_math(text, protected_math):
    for placeholder, original in protected_math.items():
        text = text.replace(placeholder, original)
    return text

# 测试
test_text = '''* $J_i$ 是离子 $i$ 的通量密度。
* $D_i$ 是离子 $i$ 在膜内的扩散系数。
* $C_i(x)$ 是离子 $i$ 在膜内距离 $x$ 处的浓度。
* $z_i$ 是离子的电荷数。'''

print("原文:")
print(test_text)
print("\n" + "="*50 + "\n")

# 保护 LaTeX 数学公式
protected_text, protected_math = protect_latex_math(test_text)
print("保护后的文本:")
print(protected_text)
print("\n保护的数学公式:")
for k, v in protected_math.items():
    print(f"  {k} -> {v}")

# Markdown 处理
md_html = markdown.markdown(protected_text, extensions=["extra"])
print("\nMarkdown 转换后:")
print(md_html)

# 简化的 Bleach 清理
ALLOWED_TAGS = ['p', 'ul', 'li', 'strong', 'em']
ALLOWED_ATTRIBUTES = {}
cleaner = Cleaner(tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRIBUTES, strip=True)
clean_html = cleaner.clean(md_html)
print("\nBleach 清理后:")
print(clean_html)

# 恢复数学公式
final_html = restore_latex_math(clean_html, protected_math)
print("\n最终结果:")
print(final_html)
