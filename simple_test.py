#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import re

def protect_latex_math(text):
    # 存储受保护的数学公式
    protected_math = {}
    counter = 0
    
    # 保护行内数学公式 $...$
    def replace_inline_math(match):
        nonlocal counter
        placeholder = f"MATHPROTECTINLINE{counter}MATHPROTECT"
        protected_math[placeholder] = match.group(0)
        counter += 1
        return placeholder
    
    # 处理行内数学公式
    text = re.sub(r'(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)', replace_inline_math, text)
    
    return text, protected_math

# 恢复受保护的数学公式
def restore_latex_math(text, protected_math):
    for placeholder, original in protected_math.items():
        text = text.replace(placeholder, original)
    return text

# 测试
test_text = '''* $J_i$ 是离子 $i$ 的通量密度。
* $D_i$ 是离子 $i$ 在膜内的扩散系数。'''

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

# 模拟 HTML 处理（简单替换）
html_like = protected_text.replace('*', '<li>').replace('\n', '</li>\n')
print("\n模拟HTML处理后:")
print(html_like)

# 恢复数学公式
final_result = restore_latex_math(html_like, protected_math)
print("\n最终结果:")
print(final_result)
