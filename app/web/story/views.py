from flask import render_template, abort

from . import story_bp
from .services import StoryService


@story_bp.route("/")
def root_collection():
    collection = StoryService.get_collection("")
    if collection is None:
        abort(404)
    return render_template("story/collection.html", collection=collection, path="")


@story_bp.route("/<path:path>")
def resolve_path(path):
    path = path.rstrip("/")

    # 尝试作为合集
    collection = StoryService.get_collection(path)
    if collection is not None:
        breadcrumbs = _build_breadcrumbs(path)
        return render_template(
            "story/collection.html",
            collection=collection,
            path=path,
            breadcrumbs=breadcrumbs,
        )

    # 尝试作为故事
    result = StoryService.get_story(path)
    if result is not None:
        story_type, data = result
        if story_type == "markdown":
            return render_template(
                "story/reader.html",
                story_title=data["title"],
                story_author=data["author"],
                story_genre=data["genre"],
                story_status=data["status"],
                story_content=data["content"],
                parent_path=data["parent_path"],
            )
        else:
            return render_template(
                "story/cattca.html",
                title=data["title"],
                author=data["author"],
                genre=data["genre"],
                status=data["status"],
                content=data["content"],
                parent_path=data["parent_path"],
            )

    abort(404)


def _build_breadcrumbs(path):
    if not path:
        return []
    parts = path.split("/")
    crumbs = []
    for i in range(len(parts)):
        partial = "/".join(parts[: i + 1])
        crumbs.append({"label": parts[i], "path": partial})
    return crumbs
