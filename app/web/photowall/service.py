import time
from flask import current_app
from app.extensions import db
from app.models.photowall import PhotoWallItem
from app.models.image import ImageHosting
from app.models.user import User
from app.web.image_hosting.service import ImageService

WALL_WIDTH = 4000
WALL_HEIGHT = 3000
MAX_ITEMS_PER_USER = 30

# In-memory rate limiters
_place_timestamps = {}   # {user_id: [timestamp, ...]}
_PLACE_RATE_MAX = 30
_PLACE_RATE_WINDOW = 3600

_update_timestamps = {}
_UPDATE_RATE_MAX = 300
_UPDATE_RATE_WINDOW = 3600


def _check_rate(key, store, limit, window):
    now = time.time()
    timestamps = store.get(key, [])
    timestamps = [t for t in timestamps if now - t < window]
    store[key] = timestamps
    if len(timestamps) >= limit:
        return False
    timestamps.append(now)
    return True


def _check_user_can_act(user_id):
    user = User.query.get(user_id)
    if not user:
        return None, '用户不存在'
    if user.is_currently_banned():
        return None, '你已被禁言，无法操作照片墙'
    return user, None


class PhotoWallService:

    @staticmethod
    def get_all_items():
        items = PhotoWallItem.query.filter_by(ignore=False).order_by(
            PhotoWallItem.z_index.asc(),
            PhotoWallItem.created_at.asc(),
        ).all()
        result = []
        for item in items:
            d = item.to_dict()
            if item.image and not item.image.ignore:
                d['url'] = f'/image/i/{item.image_id}'
            else:
                d['url'] = ''
            result.append(d)
        return result

    @staticmethod
    def _clamp_coords(x, y):
        return max(-200, min(WALL_WIDTH + 200, x)), max(-200, min(WALL_HEIGHT + 200, y))

    @staticmethod
    def place_image(image_id, author_id, x, y, rotation=0.0, scale=1.0):
        user, err = _check_user_can_act(author_id)
        if err:
            return None, err

        if not _check_rate(author_id, _place_timestamps, _PLACE_RATE_MAX, _PLACE_RATE_WINDOW):
            return None, '贴照片太频繁，请稍后再试'

        count = PhotoWallItem.query.filter_by(
            author_id=author_id, ignore=False,
        ).count()
        if count >= MAX_ITEMS_PER_USER:
            return None, f'你最多只能贴 {MAX_ITEMS_PER_USER} 张照片，请先摘除一些'

        image = ImageHosting.query.get(image_id)
        if not image or image.ignore:
            return None, '图片不存在或已被删除'

        existing = PhotoWallItem.query.filter_by(
            image_id=image_id, ignore=False,
        ).first()
        if existing:
            return None, '这张图片已经在墙上了'

        x, y = PhotoWallService._clamp_coords(x, y)
        scale = max(0.25, min(5.0, scale))
        rotation = rotation % 360

        max_z = db.session.query(db.func.max(PhotoWallItem.z_index)).filter(
            PhotoWallItem.ignore == False,
        ).scalar() or 0

        item = PhotoWallItem(
            image_id=image_id,
            author_id=author_id,
            x=x,
            y=y,
            rotation=rotation,
            scale=scale,
            z_index=max_z + 1,
        )
        db.session.add(item)
        db.session.commit()
        return item.to_dict(), None

    @staticmethod
    def update_item(item_id, author_id, **kwargs):
        user, err = _check_user_can_act(author_id)
        if err:
            return None, err

        if not _check_rate(author_id, _update_timestamps, _UPDATE_RATE_MAX, _UPDATE_RATE_WINDOW):
            return None, '操作太频繁，请稍后再试'

        item = PhotoWallItem.query.get(item_id)
        if not item or item.ignore:
            return None, '照片不存在或已被移除'

        allowed = {'x', 'y', 'rotation', 'scale', 'z_index'}
        for key, value in kwargs.items():
            if key in allowed and value is not None:
                if key == 'x' or key == 'y':
                    # Clamp on write
                    pass
                elif key == 'rotation':
                    value = value % 360
                elif key == 'scale':
                    value = max(0.25, min(5.0, value))
                setattr(item, key, value)

        item.x, item.y = PhotoWallService._clamp_coords(item.x, item.y)
        db.session.commit()
        return item.to_dict(), None

    @staticmethod
    def remove_item(item_id, author_id):
        user, err = _check_user_can_act(author_id)
        if err:
            return False, err

        item = PhotoWallItem.query.get(item_id)
        if not item or item.ignore:
            return False, '照片不存在或已被移除'
        item.ignore = True
        db.session.commit()
        return True, None

    @staticmethod
    def upload_and_place(file_content, mime_type, filename, author_id, x, y,
                         rotation=0.0, scale=1.0, compress=False):
        user, err = _check_user_can_act(author_id)
        if err:
            return None, err

        if not _check_rate(author_id, _place_timestamps, _PLACE_RATE_MAX, _PLACE_RATE_WINDOW):
            return None, '上传太频繁，请稍后再试'

        count = PhotoWallItem.query.filter_by(
            author_id=author_id, ignore=False,
        ).count()
        if count >= MAX_ITEMS_PER_USER:
            return None, f'你最多只能贴 {MAX_ITEMS_PER_USER} 张照片，请先摘除一些'

        ok, err = ImageService.validate_upload(user, file_content, mime_type, filename)
        if not ok:
            return None, err

        image_dict, err = ImageService.upload_image(user, file_content, mime_type, filename, compress)
        if err:
            return None, err

        item_dict, err = PhotoWallService.place_image(
            image_dict['id'], author_id, x, y, rotation, scale,
        )
        if err:
            return None, err

        item_dict['url'] = f"/image/i/{image_dict['id']}"
        return item_dict, None

    @staticmethod
    def get_available_images(author_id):
        wall_image_ids = db.session.query(PhotoWallItem.image_id).filter(
            PhotoWallItem.ignore == False,
        ).subquery()

        images = ImageHosting.query.filter(
            ImageHosting.author_id == author_id,
            ImageHosting.ignore == False,
            ImageHosting.id.notin_(wall_image_ids),
        ).order_by(ImageHosting.created_at.desc()).limit(50).all()

        return [img.to_dict() for img in images]

    @staticmethod
    def move_layer(item_id, direction, author_id):
        user, err = _check_user_can_act(author_id)
        if err:
            return None, err

        item = PhotoWallItem.query.filter_by(id=item_id, ignore=False).first()
        if not item:
            return None, '照片不存在'

        all_items = PhotoWallItem.query.filter_by(ignore=False).order_by(
            PhotoWallItem.z_index.asc(),
            PhotoWallItem.created_at.asc(),
        ).all()

        idx = None
        for i, it in enumerate(all_items):
            if it.id == item_id:
                idx = i
                break

        if idx is None:
            return None, '照片不存在'

        if direction == 'up' and idx < len(all_items) - 1:
            neighbor = all_items[idx + 1]
        elif direction == 'down' and idx > 0:
            neighbor = all_items[idx - 1]
        else:
            return item.to_dict(), None

        item.z_index, neighbor.z_index = neighbor.z_index, item.z_index
        db.session.commit()
        return item.to_dict(), None
