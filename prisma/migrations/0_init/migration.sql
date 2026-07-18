-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME,
    "last_login" DATETIME,
    "avatar_path" TEXT,
    "bio" TEXT,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "notify_like" BOOLEAN DEFAULT true,
    "notify_edit" BOOLEAN DEFAULT true,
    "notify_delete" BOOLEAN DEFAULT true,
    "notify_admin" BOOLEAN DEFAULT true,
    "show_recent_blogs" BOOLEAN NOT NULL DEFAULT true,
    "show_recent_comments" BOOLEAN NOT NULL DEFAULT true,
    "is_banned" BOOLEAN DEFAULT false,
    "ban_until" DATETIME,
    "ban_reason" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "total_fortune" INTEGER NOT NULL DEFAULT 0,
    "dried_fish" REAL NOT NULL DEFAULT 0,
    "fish_api_key_encrypted" TEXT
);

-- CreateTable
CREATE TABLE "invite_codes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "is_used" BOOLEAN DEFAULT false,
    "created_at" DATETIME,
    "used_by" TEXT,
    CONSTRAINT "invite_codes_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_bans" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "banned_at" DATETIME NOT NULL,
    "ban_until" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "is_lifted" BOOLEAN DEFAULT false,
    "lifted_at" DATETIME,
    "lifted_by" TEXT,
    CONSTRAINT "user_bans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_bans_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_bans_lifted_by_fkey" FOREIGN KEY ("lifted_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blogs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "author_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "ignore" BOOLEAN DEFAULT false,
    "likes_count" INTEGER DEFAULT 0,
    "fish_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER DEFAULT 0,
    "last_comment_at" DATETIME,
    "category_id" INTEGER,
    "is_featured" BOOLEAN DEFAULT false,
    CONSTRAINT "blogs_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blogs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blog_contents" (
    "blog_id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "updated_at" DATETIME,
    CONSTRAINT "blog_contents_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blog_likes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blog_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "notification_sent" BOOLEAN NOT NULL DEFAULT false,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" DATETIME,
    CONSTRAINT "blog_likes_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blog_feeds" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blog_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "created_at" DATETIME,
    "updated_at" DATETIME,
    CONSTRAINT "blog_feeds_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_feeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "categories" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "parent_id" INTEGER,
    "sort_order" INTEGER DEFAULT 0,
    "is_active" BOOLEAN DEFAULT true,
    "icon" TEXT DEFAULT '',
    "created_at" DATETIME,
    "exclude_from_all" BOOLEAN DEFAULT false,
    "admin_only_posting" BOOLEAN DEFAULT false,
    "notify_admin_on_post" BOOLEAN DEFAULT false,
    CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blog_comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blog_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "root_id" TEXT,
    "content" TEXT NOT NULL,
    "content_html" TEXT,
    "status" TEXT DEFAULT 'approved',
    "is_deleted" BOOLEAN DEFAULT false,
    "likes_count" INTEGER DEFAULT 0,
    "created_at" DATETIME,
    "updated_at" DATETIME,
    CONSTRAINT "blog_comments_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "blog_comments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "blog_comments_root_id_fkey" FOREIGN KEY ("root_id") REFERENCES "blog_comments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "comment_likes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME,
    CONSTRAINT "comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "blog_comments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME,
    "action" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "object_type" TEXT,
    "object_id" TEXT,
    "detail" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clipboards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "ignore" BOOLEAN DEFAULT false,
    "publicity" BOOLEAN DEFAULT true,
    CONSTRAINT "clipboards_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clip_text" (
    "clip_id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "updated_at" DATETIME,
    CONSTRAINT "clip_text_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "clipboards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "image_hosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "is_public" BOOLEAN DEFAULT true,
    "ignore" BOOLEAN DEFAULT false,
    CONSTRAINT "image_hosting_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "photo_wall_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "image_id" TEXT NOT NULL,
    "x" REAL NOT NULL DEFAULT 0,
    "y" REAL NOT NULL DEFAULT 0,
    "rotation" REAL NOT NULL DEFAULT 0,
    "z_index" INTEGER NOT NULL DEFAULT 0,
    "scale" REAL NOT NULL DEFAULT 1,
    "author_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "updated_at" DATETIME,
    "ignore" BOOLEAN DEFAULT false,
    CONSTRAINT "photo_wall_items_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "image_hosting" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "photo_wall_items_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "is_locked" BOOLEAN DEFAULT false,
    "ignore" BOOLEAN DEFAULT false,
    "created_at" DATETIME,
    CONSTRAINT "votes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "vote_options" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "vote_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER DEFAULT 0,
    "vote_count" INTEGER DEFAULT 0,
    CONSTRAINT "vote_options_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "votes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "vote_records" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "vote_id" TEXT NOT NULL,
    "option_id" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME,
    CONSTRAINT "vote_records_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "votes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "vote_records_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "vote_options" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "vote_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "daily_checkins" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "checkin_date" DATETIME NOT NULL,
    "created_at" DATETIME,
    "fortune_value" INTEGER,
    "fortune_pool" TEXT,
    CONSTRAINT "daily_checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fish_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "related_user_id" TEXT,
    "created_at" DATETIME,
    CONSTRAINT "fish_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fish_transactions_related_user_id_fkey" FOREIGN KEY ("related_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "admin_action_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created_at" DATETIME,
    "action" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "target_user_id" TEXT,
    "object_type" TEXT,
    "object_id" TEXT,
    "reason" TEXT,
    "extra" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    CONSTRAINT "admin_action_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "admin_action_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "admin_action_appeals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created_at" DATETIME,
    "updated_at" DATETIME,
    "log_id" INTEGER NOT NULL,
    "appellant_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "decided_by" TEXT,
    "decided_at" DATETIME,
    CONSTRAINT "admin_action_appeals_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "admin_action_logs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "admin_action_appeals_appellant_id_fkey" FOREIGN KEY ("appellant_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "admin_action_appeals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_username" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "ix_users_id" ON "users"("id");

-- CreateIndex
CREATE INDEX "ix_users_role" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "invite_codes_code_key" ON "invite_codes"("code");

-- CreateIndex
CREATE INDEX "ix_user_bans_admin_id" ON "user_bans"("admin_id");

-- CreateIndex
CREATE INDEX "ix_user_bans_user_id" ON "user_bans"("user_id");

-- CreateIndex
CREATE INDEX "ix_blogs_id" ON "blogs"("id");

-- CreateIndex
CREATE INDEX "ix_blogs_title" ON "blogs"("title");

-- CreateIndex
CREATE INDEX "ix_blogs_author_id" ON "blogs"("author_id");

-- CreateIndex
CREATE INDEX "ix_blogs_category_id" ON "blogs"("category_id");

-- CreateIndex
CREATE INDEX "ix_blogs_is_featured" ON "blogs"("is_featured");

-- CreateIndex
CREATE INDEX "ix_blogs_last_comment_at" ON "blogs"("last_comment_at");

-- CreateIndex
CREATE INDEX "ix_blogs_ignore" ON "blogs"("ignore");

-- CreateIndex
CREATE INDEX "ix_blogs_created_at" ON "blogs"("created_at");

-- CreateIndex
CREATE INDEX "ix_blog_likes_blog_id" ON "blog_likes"("blog_id");

-- CreateIndex
CREATE INDEX "ix_blog_likes_user_id" ON "blog_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blog_likes_blog_id_user_id_key" ON "blog_likes"("blog_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_blog_feeds_blog_id" ON "blog_feeds"("blog_id");

-- CreateIndex
CREATE INDEX "ix_blog_feeds_user_id" ON "blog_feeds"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blog_feeds_blog_id_user_id_key" ON "blog_feeds"("blog_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_categories_slug" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "ix_categories_notify_admin_on_post" ON "categories"("notify_admin_on_post");

-- CreateIndex
CREATE INDEX "ix_categories_admin_only_posting" ON "categories"("admin_only_posting");

-- CreateIndex
CREATE INDEX "ix_categories_sort_order" ON "categories"("sort_order");

-- CreateIndex
CREATE INDEX "ix_categories_is_active" ON "categories"("is_active");

-- CreateIndex
CREATE INDEX "ix_categories_name" ON "categories"("name");

-- CreateIndex
CREATE INDEX "ix_categories_parent_id" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX "ix_categories_exclude_from_all" ON "categories"("exclude_from_all");

-- CreateIndex
CREATE INDEX "ix_blog_comments_author_id" ON "blog_comments"("author_id");

-- CreateIndex
CREATE INDEX "ix_blog_comments_blog_id" ON "blog_comments"("blog_id");

-- CreateIndex
CREATE INDEX "ix_blog_comments_created_at" ON "blog_comments"("created_at");

-- CreateIndex
CREATE INDEX "ix_blog_comments_is_deleted" ON "blog_comments"("is_deleted");

-- CreateIndex
CREATE INDEX "ix_blog_comments_parent_id" ON "blog_comments"("parent_id");

-- CreateIndex
CREATE INDEX "ix_blog_comments_root_id" ON "blog_comments"("root_id");

-- CreateIndex
CREATE INDEX "ix_blog_comments_status" ON "blog_comments"("status");

-- CreateIndex
CREATE INDEX "ix_comment_likes_comment_id" ON "comment_likes"("comment_id");

-- CreateIndex
CREATE INDEX "ix_comment_likes_user_id" ON "comment_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_likes_comment_id_user_id_key" ON "comment_likes"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_notifications_timestamp" ON "notifications"("timestamp");

-- CreateIndex
CREATE INDEX "ix_clipboards_author_id" ON "clipboards"("author_id");

-- CreateIndex
CREATE INDEX "ix_clipboards_created_at" ON "clipboards"("created_at");

-- CreateIndex
CREATE INDEX "ix_clipboards_id" ON "clipboards"("id");

-- CreateIndex
CREATE INDEX "ix_clipboards_ignore" ON "clipboards"("ignore");

-- CreateIndex
CREATE INDEX "ix_clipboards_publicity" ON "clipboards"("publicity");

-- CreateIndex
CREATE INDEX "ix_clipboards_title" ON "clipboards"("title");

-- CreateIndex
CREATE INDEX "ix_image_hosting_author_id" ON "image_hosting"("author_id");

-- CreateIndex
CREATE INDEX "ix_image_hosting_created_at" ON "image_hosting"("created_at");

-- CreateIndex
CREATE INDEX "ix_image_hosting_id" ON "image_hosting"("id");

-- CreateIndex
CREATE INDEX "ix_image_hosting_ignore" ON "image_hosting"("ignore");

-- CreateIndex
CREATE INDEX "ix_photo_wall_items_author_id" ON "photo_wall_items"("author_id");

-- CreateIndex
CREATE INDEX "ix_photo_wall_items_created_at" ON "photo_wall_items"("created_at");

-- CreateIndex
CREATE INDEX "ix_photo_wall_items_id" ON "photo_wall_items"("id");

-- CreateIndex
CREATE INDEX "ix_photo_wall_items_ignore" ON "photo_wall_items"("ignore");

-- CreateIndex
CREATE INDEX "ix_photo_wall_items_image_id" ON "photo_wall_items"("image_id");

-- CreateIndex
CREATE INDEX "ix_votes_author_id" ON "votes"("author_id");

-- CreateIndex
CREATE INDEX "ix_vote_options_vote_id" ON "vote_options"("vote_id");

-- CreateIndex
CREATE INDEX "ix_vote_records_vote_id" ON "vote_records"("vote_id");

-- CreateIndex
CREATE UNIQUE INDEX "vote_records_vote_id_user_id_key" ON "vote_records"("vote_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_daily_checkins_user_id" ON "daily_checkins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_checkins_user_id_checkin_date_key" ON "daily_checkins"("user_id", "checkin_date");

-- CreateIndex
CREATE INDEX "ix_fish_transactions_type" ON "fish_transactions"("type");

-- CreateIndex
CREATE INDEX "ix_fish_transactions_related_user_id" ON "fish_transactions"("related_user_id");

-- CreateIndex
CREATE INDEX "ix_fish_transactions_user_id" ON "fish_transactions"("user_id");

-- CreateIndex
CREATE INDEX "ix_fish_transactions_created_at" ON "fish_transactions"("created_at");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_admin_id" ON "admin_action_logs"("admin_id");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_created_at" ON "admin_action_logs"("created_at");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_visibility" ON "admin_action_logs"("visibility");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_object_id" ON "admin_action_logs"("object_id");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_action" ON "admin_action_logs"("action");

-- CreateIndex
CREATE INDEX "ix_admin_action_logs_target_user_id" ON "admin_action_logs"("target_user_id");

-- CreateIndex
CREATE INDEX "ix_admin_action_appeals_log_id" ON "admin_action_appeals"("log_id");

-- CreateIndex
CREATE INDEX "ix_admin_action_appeals_created_at" ON "admin_action_appeals"("created_at");

-- CreateIndex
CREATE INDEX "ix_admin_action_appeals_appellant_id" ON "admin_action_appeals"("appellant_id");

-- CreateIndex
CREATE INDEX "ix_admin_action_appeals_status" ON "admin_action_appeals"("status");
