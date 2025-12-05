from typing import Tuple, Dict, Any


class CommentValidator:
    """评论数据校验器"""

    @staticmethod
    def validate_create_data(data: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
        if not isinstance(data, dict):
            return False, '请求数据格式错误', {}

        content = data.get('content')
        parent_id = data.get('parent_id')

        if content is None:
            return False, '评论内容不能为空', {}
        if not isinstance(content, str):
            return False, '评论内容格式错误', {}

        content = content.strip()
        if not content:
            return False, '评论内容不能为空', {}
        if len(content) > 2000:
            return False, '评论内容不能超过2000字', {}

        if parent_id is not None and not isinstance(parent_id, str):
            return False, '父评论ID格式错误', {}

        return True, '', {'content': content, 'parent_id': parent_id}


