import hashlib
import os
from PIL import Image, ImageDraw
import argparse

def generate_identicon(input_string: str, size: int = 250, grid_size: int = 5) -> Image.Image:
    """
    根据输入的字符串在内存中生成一个 GitHub 风格的 identicon 图像对象。
    这个函数是“纯”的，它不执行任何文件 I/O 操作。

    :param input_string: 用于生成头像的唯一字符串（如用户名）。
    :param size: 生成图像的尺寸（像素）。
    :param grid_size: 网格的大小，GitHub 默认为 5x5。
    :return: Pillow 的 Image 对象。
    """
    hash_object = hashlib.md5(input_string.encode('utf-8'))
    hex_digest = hash_object.hexdigest()

    r = int(hex_digest[0:2], 16)
    g = int(hex_digest[2:4], 16)
    b = int(hex_digest[4:6], 16)
    color = (r, g, b)

    grid = [[False] * grid_size for _ in range(grid_size)]
    hash_index = 6
    for row in range(grid_size):
        for col in range((grid_size + 1) // 2):
            if int(hex_digest[hash_index], 16) % 2 == 0:
                grid[row][col] = True
                grid[row][grid_size - 1 - col] = True
            hash_index = (hash_index + 1) % len(hex_digest)

    block_size = size // grid_size
    image = Image.new('RGB', (size, size), color=(240, 240, 240))
    draw = ImageDraw.Draw(image)

    for row in range(grid_size):
        for col in range(grid_size):
            if grid[row][col]:
                x0 = col * block_size
                y0 = row * block_size
                x1 = x0 + block_size
                y1 = y0 + block_size
                draw.rectangle([x0, y0, x1, y1], fill=color, outline=None)

    return image

# <--- 这是我们为 Flask 应用创建的新函数 --->
def create_and_save_avatar(input_string: str, output_path: str, size: int = 250) -> str:
    """
    生成一个 identicon 并将其保存到指定路径。
    如果目标目录不存在，会自动创建。

    :param input_string: 用于生成头像的字符串。
    :param output_path: 完整的保存路径 (例如 'instance/avatars/user.png')。
    :param size: 图像尺寸。
    :return: 保存成功后的文件路径。
    """
    # 1. 在内存中生成图像
    avatar_image = generate_identicon(input_string, size=size)

    # 2. 确保输出目录存在
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # 3. 保存图像到文件
    avatar_image.save(output_path)
    
    print(f"头像已成功保存到 '{output_path}'")
    return output_path

# --- 主程序入口（用于命令行测试）---
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="生成一个 GitHub 风格的点阵头像。")
    parser.add_argument("text", help="用于生成头像的输入文本。")
    parser.add_argument("-o", "--output", default="avatar.png", help="输出图像的文件路径。")
    parser.add_argument("-s", "--size", type=int, default=250, help="图像尺寸。")
    
    args = parser.parse_args()

    print(f"正在为 '{args.text}' 生成头像...")
    # 直接调用新的高层级函数
    try:
        create_and_save_avatar(
            input_string=args.text,
            output_path=args.output,
            size=args.size
        )
    except Exception as e:
        print(f"生成头像时发生错误: {e}")

