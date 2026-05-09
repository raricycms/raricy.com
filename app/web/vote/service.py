import time
from datetime import datetime
from flask import current_app
from app.extensions import db
from app.models.vote import Vote, VoteOption, VoteRecord
from app.utils.generate_stringid import generate_id


class RateLimiter:
    def __init__(self, max_count, window=3600):
        self._timestamps = {}
        self.max_count = max_count
        self.window = window

    def check(self, user_id):
        now = time.time()
        timestamps = self._timestamps.get(user_id, [])
        timestamps = [t for t in timestamps if now - t < self.window]
        self._timestamps[user_id] = timestamps
        if len(timestamps) >= self.max_count:
            return False
        timestamps.append(now)
        return True


_create_limiter = RateLimiter(max_count=10)
_cast_limiter = RateLimiter(max_count=30)
_MAX_VOTES_PER_USER = 100


class VoteService:

    @staticmethod
    def create_vote(user_id, title, options):
        if not _create_limiter.check(user_id):
            return None, '创建频率过高，请稍后再试'

        existing = VoteRecord.query.filter_by(user_id=user_id).count()
        if existing >= _MAX_VOTES_PER_USER:
            return None, f'每个用户最多创建 {_MAX_VOTES_PER_USER} 个投票'

        for _ in range(10):
            vote_id = generate_id(9)
            if not Vote.query.get(vote_id):
                break
        else:
            return None, '无法生成唯一ID，请重试'

        vote = Vote(id=vote_id, title=title, author_id=user_id)
        db.session.add(vote)

        for i, label in enumerate(options):
            opt = VoteOption(vote_id=vote_id, label=label, sort_order=i)
            db.session.add(opt)

        db.session.commit()
        return vote_id, None

    @staticmethod
    def get_vote(vote_id, current_user_id):
        vote = Vote.query.filter_by(id=vote_id, ignore=False).first()
        if not vote:
            return None

        options = VoteOption.query.filter_by(vote_id=vote_id)\
            .order_by(VoteOption.sort_order).all()

        user_record = VoteRecord.query.filter_by(
            vote_id=vote_id, user_id=current_user_id).first()

        total_votes = sum(opt.vote_count for opt in options)
        is_creator = vote.author_id == current_user_id

        result = {
            'id': vote.id,
            'title': vote.title,
            'author_id': vote.author_id,
            'author_name': vote.author.username if vote.author else None,
            'is_creator': is_creator,
            'is_locked': vote.is_locked,
            'created_at': vote.created_at.isoformat() if vote.created_at else None,
            'total_votes': total_votes,
            'user_voted': user_record.option_id if user_record else None,
            'options': [],
        }

        for opt in options:
            pct = round(opt.vote_count / total_votes * 100, 1) if total_votes > 0 else 0
            opt_data = {
                'id': opt.id,
                'label': opt.label,
                'count': opt.vote_count,
                'percentage': pct,
            }
            if is_creator:
                records = VoteRecord.query.filter_by(option_id=opt.id)\
                    .order_by(VoteRecord.created_at).all()
                opt_data['voters'] = [r.user.username for r in records if r.user]
            result['options'].append(opt_data)

        return result

    @staticmethod
    def get_vote_api(vote_id, current_user_id):
        return VoteService.get_vote(vote_id, current_user_id)

    @staticmethod
    def cast_vote(vote_id, option_id, user_id):
        vote = Vote.query.filter_by(id=vote_id, ignore=False).first()
        if not vote:
            return False, '投票不存在'
        if vote.is_locked:
            return False, '投票已锁定，无法投票'

        option = VoteOption.query.filter_by(id=option_id, vote_id=vote_id).first()
        if not option:
            return False, '选项不存在'

        existing = VoteRecord.query.filter_by(vote_id=vote_id, user_id=user_id).first()
        if existing:
            return False, '您已经投过票了'

        if not _cast_limiter.check(user_id):
            return False, '投票频率过高，请稍后再试'

        record = VoteRecord(vote_id=vote_id, option_id=option_id, user_id=user_id)
        option.vote_count += 1
        db.session.add(record)
        db.session.commit()
        return True, None

    @staticmethod
    def lock_vote(vote_id, user_id):
        vote = Vote.query.filter_by(id=vote_id, ignore=False).first()
        if not vote:
            return False, '投票不存在'
        if vote.author_id != user_id:
            return False, '只有投票发起者可以锁定投票'
        vote.is_locked = True
        db.session.commit()
        return True, None

    @staticmethod
    def unlock_vote(vote_id, user_id):
        vote = Vote.query.filter_by(id=vote_id, ignore=False).first()
        if not vote:
            return False, '投票不存在'
        if vote.author_id != user_id:
            return False, '只有投票发起者可以解锁投票'
        vote.is_locked = False
        db.session.commit()
        return True, None

    @staticmethod
    def delete_vote(vote_id, user_id):
        from flask_login import current_user
        vote = Vote.query.filter_by(id=vote_id, ignore=False).first()
        if not vote:
            return False, '投票不存在'
        if vote.author_id != user_id and not current_user.is_owner:
            return False, '无权删除此投票'
        vote.ignore = True
        db.session.commit()
        return True, None

    @staticmethod
    def list_user_votes(user_id):
        votes = Vote.query.filter_by(author_id=user_id, ignore=False)\
            .order_by(Vote.created_at.desc()).all()
        result = []
        for v in votes:
            option_count = VoteOption.query.filter_by(vote_id=v.id).count()
            total_votes = db.session.query(db.func.sum(VoteOption.vote_count))\
                .filter(VoteOption.vote_id == v.id).scalar() or 0
            result.append({
                'id': v.id,
                'title': v.title,
                'option_count': option_count,
                'total_votes': total_votes,
                'is_locked': v.is_locked,
                'created_at': v.created_at.isoformat() if v.created_at else None,
            })
        return result
