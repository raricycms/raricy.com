import os
import json
from dataclasses import dataclass, field

import markdown
import frontmatter
from flask import current_app

from ...utils.markdown_countword import count_markdown_words


@dataclass
class CollectionItem:
    type: str          # "story" or "collection"
    id: str
    title: str
    description: str = ""
    author: str = ""
    priority: int = 0
    # story only
    genre: str = ""
    ai_assisted: bool = False
    word_count: int = 0
    # collection only
    item_count: int = 0


@dataclass
class Collection:
    title: str
    description: str
    items: list = field(default_factory=list)


class StoryService:

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    @staticmethod
    def get_collection(path):
        """
        Return Collection for the given relative path, or None.
        An empty path means the root stories directory.
        """
        root = StoryService._stories_root()
        coll_dir = os.path.join(root, path) if path else root

        if not os.path.isdir(coll_dir):
            return None

        info = StoryService._read_json(os.path.join(coll_dir, "info.json")) or {}
        if info.get("ignore"):
            return None

        fallback_author = info.get("author", "未知作者")
        display_title = info.get("title") or (os.path.basename(coll_dir) if path else "故事")

        collection = Collection(title=display_title, description=info.get("description", ""))

        try:
            entries = sorted(os.listdir(coll_dir), key=lambda x: x.lower())
        except OSError:
            return collection

        for name in entries:
            full = os.path.join(coll_dir, name)

            if name.endswith(".md"):
                item = StoryService._load_markdown_item(full, name[:-3], fallback_author)
                if item:
                    collection.items.append(item)

            elif name.endswith(".cattca"):
                item = StoryService._load_cattca_item(full, name[:-7], fallback_author)
                if item:
                    collection.items.append(item)

            elif os.path.isdir(full) and name != "__pycache__":
                sub_info = StoryService._read_json(os.path.join(full, "info.json")) or {}
                if sub_info.get("ignore"):
                    continue
                collection.items.append(CollectionItem(
                    type="collection",
                    id=name,
                    title=sub_info.get("title", name),
                    description=sub_info.get("description", ""),
                    author=sub_info.get("author", fallback_author),
                    priority=sub_info.get("priority", 0),
                    item_count=StoryService._count_items(full),
                ))

        collection.items.sort(key=lambda x: (x.priority, bool(x.description)), reverse=True)
        return collection

    @staticmethod
    def get_story(path):
        """
        Return (story_type, data_dict) for a story path, or None.

        story_type is "markdown" or "cattca".
        data_dict has keys: title, author, genre, status, content, parent_path
        """
        if not path:
            return None

        if "/" in path:
            parent_path, story_id = path.rsplit("/", 1)
        else:
            parent_path, story_id = "", path

        root = StoryService._stories_root()
        parent_dir = os.path.join(root, parent_path) if parent_path else root

        if not os.path.isdir(parent_dir):
            return None

        parent_info = StoryService._read_json(os.path.join(parent_dir, "info.json")) or {}
        fallback_author = parent_info.get("author", "未知作者")

        # Try Markdown
        md_path = os.path.join(parent_dir, f"{story_id}.md")
        if os.path.isfile(md_path):
            try:
                post = frontmatter.load(md_path)
                meta = post.metadata
                html = markdown.markdown(
                    post.content,
                    extensions=["extra", "codehilite", "tables", "toc"],
                )
                return "markdown", {
                    "title": meta.get("title", story_id),
                    "author": meta.get("author", fallback_author),
                    "genre": meta.get("genre", ""),
                    "ai_assisted": bool(meta.get("ai_assisted", False)),
                    "content": html,
                    "parent_path": parent_path,
                }
            except Exception:
                return None

        # Try Cattca
        cattca_path = os.path.join(parent_dir, f"{story_id}.cattca")
        if os.path.isfile(cattca_path):
            try:
                post = frontmatter.load(cattca_path)
                meta = post.metadata
                return "cattca", {
                    "title": meta.get("title", story_id),
                    "author": meta.get("author", fallback_author),
                    "genre": meta.get("genre", ""),
                    "ai_assisted": bool(meta.get("ai_assisted", False)),
                    "content": post.content,
                    "parent_path": parent_path,
                }
            except Exception:
                return None

        return None

    @staticmethod
    def walk_all():
        """
        Generator for sitemap / breadcrumbs.
        Yields ('collection', rel_path) and ('story', rel_parent_path, story_id).
        """
        root = StoryService._stories_root()
        if not os.path.isdir(root):
            return

        def _walk(dir_path, rel_path):
            info = StoryService._read_json(os.path.join(dir_path, "info.json")) or {}
            if info.get("ignore"):
                return
            yield ("collection", rel_path)
            try:
                entries = os.listdir(dir_path)
            except OSError:
                return
            for name in entries:
                full = os.path.join(dir_path, name)
                if name.endswith(".md"):
                    try:
                        post = frontmatter.load(full)
                        if not post.metadata.get("ignore"):
                            yield ("story", rel_path, name[:-3])
                    except Exception:
                        pass
                elif name.endswith(".cattca"):
                    try:
                        post = frontmatter.load(full)
                        if not post.metadata.get("ignore"):
                            yield ("story", rel_path, name[:-7])
                    except Exception:
                        pass
                elif os.path.isdir(full) and name != "__pycache__":
                    sub_rel = f"{rel_path}/{name}" if rel_path else name
                    yield from _walk(full, sub_rel)

        yield from _walk(root, "")

    # ------------------------------------------------------------------ #
    # Private helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _stories_root():
        return os.path.join(current_app.instance_path, "stories")

    @staticmethod
    def _read_json(path):
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None

    @staticmethod
    def _load_markdown_item(md_path, story_id, fallback_author):
        try:
            post = frontmatter.load(md_path)
            meta = post.metadata
            if meta.get("ignore"):
                return None
            wc = count_markdown_words(md_path)["non_whitespace_characters"]
            return StoryService._build_item(story_id, meta, fallback_author, wc)
        except Exception:
            return None

    @staticmethod
    def _load_cattca_item(cattca_path, story_id, fallback_author):
        try:
            post = frontmatter.load(cattca_path)
            meta = post.metadata
            if meta.get("ignore"):
                return None
            wc = count_markdown_words(cattca_path)["non_whitespace_characters"]
            return StoryService._build_item(story_id, meta, fallback_author, wc)
        except Exception:
            return None

    @staticmethod
    def _build_item(story_id, meta, fallback_author, word_count):
        return CollectionItem(
            type="story",
            id=story_id,
            title=meta.get("title", story_id),
            description=meta.get("description", ""),
            author=meta.get("author", fallback_author),
            priority=meta.get("priority", 0),
            genre=meta.get("genre", ""),
            ai_assisted=bool(meta.get("ai_assisted", False)),
            word_count=word_count,
        )

    @staticmethod
    def _count_items(dir_path):
        count = 0
        try:
            for name in os.listdir(dir_path):
                if name.endswith(".md") or name.endswith(".cattca"):
                    count += 1
                elif os.path.isdir(os.path.join(dir_path, name)) and name != "__pycache__":
                    count += 1
        except OSError:
            pass
        return count
