from flask import render_template

from . import story_bp

# TODO: 恢复故事模块时，删除下面的 catch-all 并取消注释原有的路由函数，然后删除末尾注释块


@story_bp.route("/")
@story_bp.route("/<path:path>")
def root_collection(path=None):
    return render_template("story/maintenance.html"), 503


# --- 原始路由（已暂时关闭）---
#
# from .services import StoryService
#
# @story_bp.route("/")
# def root_collection():
#     collection = StoryService.get_collection("")
#     if collection is None:
#         abort(404)
#     return render_template("story/collection.html", collection=collection, path="")
#
#
# @story_bp.route("/<path:path>")
# def resolve_path(path):
#     path = path.rstrip("/")
#
#     collection = StoryService.get_collection(path)
#     if collection is not None:
#         breadcrumbs = _build_breadcrumbs(path)
#         return render_template(
#             "story/collection.html",
#             collection=collection,
#             path=path,
#             breadcrumbs=breadcrumbs,
#         )
#
#     result = StoryService.get_story(path)
#     if result is not None:
#         story_type, data = result
#         if story_type == "markdown":
#             return render_template(
#                 "story/reader.html",
#                 story_title=data["title"],
#                 story_author=data["author"],
#                 story_genre=data["genre"],
#                 story_status=data["status"],
#                 story_content=data["content"],
#                 parent_path=data["parent_path"],
#             )
#         else:
#             return render_template(
#                 "story/cattca.html",
#                 title=data["title"],
#                 author=data["author"],
#                 genre=data["genre"],
#                 status=data["status"],
#                 content=data["content"],
#                 parent_path=data["parent_path"],
#             )
#
#     abort(404)
#
#
# def _build_breadcrumbs(path):
#     if not path:
#         return []
#     parts = path.split("/")
#     crumbs = []
#     for i in range(len(parts)):
#         partial = "/".join(parts[: i + 1])
#         crumbs.append({"label": parts[i], "path": partial})
#     return crumbs
