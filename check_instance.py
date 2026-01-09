import os
from pathlib import Path

def check_instance_structure():
    base_path = Path("instance")
    required_dirs = [
        "avatars",
        "database",
        "stories",
        "blogs"
    ]
    
    # 检查并创建instance文件夹
    if not base_path.exists():
        base_path.mkdir()
        print(f"已创建文件夹: {base_path}")
    
    # 检查并创建子文件夹
    for dir_name in required_dirs:
        dir_path = base_path / dir_name
        if not dir_path.exists():
            dir_path.mkdir()
            print(f"已创建文件夹: {dir_path}")
    
    
    print("文件夹结构检查完成！")

if __name__ == "__main__":
    check_instance_structure()
