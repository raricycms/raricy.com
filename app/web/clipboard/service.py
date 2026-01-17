from datetime import datetime
from flask_login import current_user
from app.extensions import db
from app.models import ClipBoard, ClipText, User
from app.utils.generate_stringid import generate_id

class ClipService:

    @staticmethod
    def create_clipboard(validated_data):
        clip_id = generate_id()

        clip = ClipBoard(
            id=clip_id,
            title=validated_data['title'],
            author_id=current_user.id,
            publicity=validated_data['publicity'],
        )
        content_obj = ClipText(clip_id=clip_id, content=validated_data['content'])
        db.session.add(clip)
        db.session.add(content_obj)
        db.session.commit()

        return clip_id

    @staticmethod
    def update_clipboard(clip_id, validated_data):
        clip = ClipBoard.query.get(clip_id)
        if not clip:
            return False, []

        changes_detail = []

        has_changes = False
        if clip.title != validated_data['title']:
            changes_detail.append(f'title update from {clip.title} to {validated_data["title"]}')
            has_changes = True
        if clip.publicity != validated_data['publicity']:
            changes_detail.append(f'publicity update from {clip.publicity} to {validated_data["publicity"]}')
            has_changes = True

        content_obj = ClipText.query.get(clip_id)
        old_content = content_obj.content if content_obj else ''

        if old_content != validated_data['content']:
            changes_detail.append('content changed')
            has_changes = True

        clip.title = validated_data['title']
        clip.publicity = validated_data['publicity']
        if not content_obj:
            content_obj = ClipText(clip_id=clip_id, content=validated_data['content'])
            db.session.add(content_obj)
        else:
            content_obj.content = validated_data['content']

        db.session.commit()

        return has_changes, changes_detail

    @staticmethod
    def delete_clipboard(clip_id):
        clip = ClipBoard.query.get(clip_id)
        if not clip:
            return False

        clip.ignore = True
        db.session.commit()
        return True

    @staticmethod
    def recover_clipboard(clip_id):
        clip = ClipBoard.query.get(clip_id)
        if not clip:
            return False

        clip.ignore = False
        db.session.commit()
        return True

    @staticmethod
    def get_clipboard(clip_id):
        clip = ClipBoard.query.get(clip_id)
        if not clip or clip.ignore:
            return None
        clip_content = ClipText.query.get(clip_id) if clip else ''
        clip_content = clip_content.content if clip_content else ''

        author = User.query.get(clip.author_id)
        author_name = author.username if author else ''

        clip_dic = clip.to_dict()
        clip_dic['author_name'] = author_name
        return clip_dic

    @staticmethod
    def get_clipboard_with_content(clip_id):
        clip = ClipBoard.query.get(clip_id)
        if not clip or clip.ignore:
            return None
        clip_content = ClipText.query.get(clip_id) if clip else ''
        clip_content = clip_content.content if clip_content else ''

        author = User.query.get(clip.author_id)
        author_name = author.username if author else ''

        clip_dic = clip.to_dict()
        clip_dic['content'] = clip_content
        clip_dic['author_name'] = author_name
        return clip_dic

    @staticmethod
    def get_clipboard_byuserid(user_id):
        clipboards = ClipBoard.query.filter_by(
            author_id=user_id,
            ignore=False
        ).order_by(ClipBoard.created_at.desc()).all()
        
        return [{"id": cb.id, "title": cb.title} for cb in clipboards]

    @staticmethod
    def get_clipboard_list():
        clipboards = ClipBoard.query.filter_by(
            ignore=False
        ).order_by(ClipBoard.created_at.desc()).all()

        return [{"id": cb.id, "title": cb.title} for cb in clipboards]
    

