import re

def count_markdown_words(file_path):
    # 读取Markdown文件内容
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # 移除代码块（```包裹的内容）
    content = re.sub(r'```.*?```', '', content, flags=re.DOTALL)
    
    # 移除行内代码（`包裹的内容）
    content = re.sub(r'`.*?`', '', content)
    
    # 移除图片标记（![alt](url)）
    content = re.sub(r'!\[.*?\]\(.*?\)', '', content)
    
    # 移除链接标记（[text](url)）
    content = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', content)  # 保留链接文本
    
    # 移除HTML标签（可选）
    content = re.sub(r'<.*?>', '', content)
    
    # 移除Markdown特殊字符（* _ ~ > # - [ ] ( ) ` !）
    markdown_chars = r'[*_~>`#\-\[\]()!]'
    content = re.sub(markdown_chars, '', content)
    
    # 移除连续空格和换行符，替换为单个空格
    content = re.sub(r'\s+', ' ', content).strip()
    
    # 统计字数（按非空字符计数）
    word_count = len(content)  # 总字符数（含空格）
    char_count = len(re.sub(r'\s', '', content))  # 非空白字符数
    
    return {
        'total_characters': word_count,
        'non_whitespace_characters': char_count
    }

# 使用示例
if __name__ == "__main__":
    file_path = "example.md"  # 替换为你的Markdown文件路径
    counts = count_markdown_words(file_path)
    print(f"总字符数（含空格）: {counts['total_characters']}")
    print(f"非空白字符数: {counts['non_whitespace_characters']}")