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
    
    # 检查stories文件夹下的子文件夹结构
    stories_path = base_path / "stories"
    for i in range(1, 4):
        batch_dir = stories_path / f"mainstories_batch{i}"
        if not batch_dir.exists():
            batch_dir.mkdir()
            print(f"已创建文件夹: {batch_dir}")
            
            # 在每个batch文件夹中创建info.json和示例故事文件
            (batch_dir / "info.json").touch()
            for j in range(1, 3):
                (batch_dir / f"teststory{j}.md").touch()
    
    print("文件夹结构检查完成！")

if __name__ == "__main__":
    check_instance_structure()