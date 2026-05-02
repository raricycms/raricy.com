from typing import Tuple, Dict, Any


class MessageValidator:

    @staticmethod
    def validate_create_data(data: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
        if not isinstance(data, dict):
            return False, '请求数据格式错误', {}

        content = data.get('content')
        parent_id = data.get('parent_id')
        is_anonymous = data.get('is_anonymous', False)

        if content is None:
            return False, '留言内容不能为空', {}
        if not isinstance(content, str):
            return False, '留言内容格式错误', {}
        content = content.strip()
        if not content:
            return False, '留言内容不能为空', {}
        if len(content) > 500:
            return False, '留言内容不能超过500字', {}

        if parent_id is not None and not isinstance(parent_id, str):
            return False, '父留言ID格式错误', {}

        if not isinstance(is_anonymous, bool):
            return False, '匿名选项格式错误', {}

        return True, '', {
            'content': content,
            'parent_id': parent_id,
            'is_anonymous': is_anonymous,
        }
