import os
import io
import time
from datetime import datetime
from flask import current_app
from app.extensions import db
from app.models.image import ImageHosting, generate_image_id

try:
    from PIL import Image as PILImage
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

ALLOWED_MIMETYPES = {
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
}

QUOTA_LIMITS_MB = {
    'core': 20,
    'admin': 30,
    'owner': 50,
}

# In-memory rate limiter: {user_id: [timestamp, ...]}
_upload_timestamps = {}
_RATE_LIMIT_MAX = 30
_RATE_LIMIT_WINDOW = 3600


def _check_rate_limit(user_id):
    now = time.time()
    timestamps = _upload_timestamps.get(user_id, [])
    timestamps = [t for t in timestamps if now - t < _RATE_LIMIT_WINDOW]
    _upload_timestamps[user_id] = timestamps
    if len(timestamps) >= _RATE_LIMIT_MAX:
        return False
    timestamps.append(now)
    return True


class ImageService:

    @staticmethod
    def _get_upload_folder():
        folder = current_app.config.get('IMAGE_UPLOAD_FOLDER')
        os.makedirs(folder, exist_ok=True)
        return folder

    @staticmethod
    def compress_image(file_content, mime_type):
        if not HAS_PILLOW:
            return file_content, mime_type

        if mime_type in ('image/svg+xml', 'image/gif'):
            return file_content, mime_type

        try:
            img = PILImage.open(io.BytesIO(file_content))

            # Resize if max dimension exceeds 2000px
            max_dim = 2000
            w, h = img.size
            if max(w, h) > max_dim:
                ratio = max_dim / max(w, h)
                img = img.resize((int(w * ratio), int(h * ratio)), PILImage.LANCZOS)

            # Convert RGBA to RGB for JPEG output
            if mime_type == 'image/jpeg' and img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')

            out = io.BytesIO()
            save_kwargs = {'optimize': True}

            if mime_type == 'image/jpeg':
                save_kwargs['format'] = 'JPEG'
                save_kwargs['quality'] = 85
            elif mime_type == 'image/png':
                save_kwargs['format'] = 'PNG'
                # Quantize to reduce palette if possible
                if img.mode == 'RGBA':
                    img = img.quantize(colors=256, method=PILImage.Quantize.MEDIANCUT)
            elif mime_type == 'image/webp':
                save_kwargs['format'] = 'WebP'
                save_kwargs['quality'] = 85
            else:
                return file_content, mime_type

            img.save(out, **save_kwargs)
            compressed = out.getvalue()

            # Only use compressed version if it's actually smaller
            if len(compressed) < len(file_content):
                return compressed, mime_type
        except Exception:
            pass

        return file_content, mime_type

    @staticmethod
    def get_quota_limit_mb(user):
        role = getattr(user, 'role', 'user')
        return QUOTA_LIMITS_MB.get(role, 0)

    @staticmethod
    def get_user_used_bytes(user_id):
        result = db.session.query(db.func.sum(ImageHosting.file_size)).filter(
            ImageHosting.author_id == user_id,
            ImageHosting.ignore == False,
        ).scalar()
        return result or 0

    @staticmethod
    def get_user_quota(user):
        used = ImageService.get_user_used_bytes(user.id)
        limit_mb = ImageService.get_quota_limit_mb(user)
        limit_bytes = limit_mb * 1024 * 1024
        remaining = max(0, limit_bytes - used)
        return {
            'used_mb': round(used / (1024 * 1024), 2),
            'limit_mb': limit_mb,
            'remaining_mb': round(remaining / (1024 * 1024), 2),
            'usage_percent': round(used / limit_bytes * 100, 1) if limit_bytes > 0 else 100,
        }

    @staticmethod
    def validate_upload(user, file_content, mime_type, filename, user_id_for_rate=None):
        max_size = current_app.config.get('MAX_IMAGE_SIZE', 10 * 1024 * 1024)

        if mime_type not in ALLOWED_MIMETYPES:
            return False, '不支持的文件格式，仅允许 PNG、JPEG、GIF、WebP、SVG'

        if len(file_content) > max_size:
            max_mb = max_size / (1024 * 1024)
            return False, f'文件过大，单文件上限 {max_mb:.0f} MB'

        limit_mb = ImageService.get_quota_limit_mb(user)
        if limit_mb == 0:
            return False, '你的角色无权使用图床'

        used = ImageService.get_user_used_bytes(user.id)
        limit_bytes = limit_mb * 1024 * 1024
        if used + len(file_content) > limit_bytes:
            return False, f'存储空间不足，你的配额为 {limit_mb} MB'

        rate_key = user_id_for_rate or user.id
        if not _check_rate_limit(rate_key):
            return False, '上传频率过高，请稍后再试'

        return True, None

    @staticmethod
    def upload_image(user, file_content, mime_type, filename, compress=False):
        max_retries = 10
        for _ in range(max_retries):
            image_id = generate_image_id()
            if not ImageHosting.query.get(image_id):
                break
        else:
            return None, '无法生成唯一ID，请重试'

        ext_map = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
        }
        ext = ext_map.get(mime_type, '')

        if compress:
            original_size = len(file_content)
            file_content, mime_type = ImageService.compress_image(file_content, mime_type)
            # Update extension if mime_type changed (e.g., RGBA PNG converted)
            ext = ext_map.get(mime_type, ext)

        folder = ImageService._get_upload_folder()
        filepath = os.path.join(folder, image_id + ext)
        with open(filepath, 'wb') as f:
            f.write(file_content)

        image = ImageHosting(
            id=image_id,
            filename=filename,
            file_size=len(file_content),
            mime_type=mime_type,
            author_id=user.id,
        )
        db.session.add(image)
        db.session.commit()

        return image.to_dict(), None

    @staticmethod
    def get_user_images(user_id):
        images = ImageHosting.query.filter_by(
            author_id=user_id,
            ignore=False,
        ).order_by(ImageHosting.created_at.desc()).all()
        return [img.to_dict() for img in images]

    @staticmethod
    def get_image_by_id(image_id):
        return ImageHosting.query.get(image_id)

    @staticmethod
    def soft_delete_image(image_id, user):
        image = ImageHosting.query.get(image_id)
        if not image:
            return False, '图片不存在'
        if image.author_id != user.id and not user.has_admin_rights:
            return False, '无权删除此图片'
        if image.ignore:
            return False, '图片已被删除'
        image.ignore = True
        db.session.commit()
        return True, None

    @staticmethod
    def hard_delete_image(image_id):
        image = ImageHosting.query.get(image_id)
        if not image:
            return False, '图片不存在'

        filepath = image.storage_path
        if os.path.exists(filepath):
            os.remove(filepath)

        db.session.delete(image)
        db.session.commit()
        return True, None

    @staticmethod
    def get_all_images(page=1, per_page=30, search=None):
        query = ImageHosting.query.filter_by(ignore=False)

        if search:
            from app.models.user import User
            matching_users = User.query.filter(
                User.username.contains(search)
            ).with_entities(User.id).all()
            user_ids = [u[0] for u in matching_users]
            query = query.filter(
                db.or_(
                    ImageHosting.filename.contains(search),
                    ImageHosting.author_id.in_(user_ids),
                )
            )

        query = query.order_by(ImageHosting.created_at.desc())
        pagination = query.paginate(page=page, per_page=per_page, error_out=False)
        return {
            'images': [img.to_dict() for img in pagination.items],
            'total': pagination.total,
            'pages': pagination.pages,
            'page': page,
        }

    @staticmethod
    def get_total_storage_bytes():
        result = db.session.query(db.func.sum(ImageHosting.file_size)).filter(
            ImageHosting.ignore == False,
        ).scalar()
        return result or 0
