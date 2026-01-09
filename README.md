这是 聪明山 的个人网站！

powered by Flask & Bootstrap & Vditor & Turnstile   
感谢 deepask.cc & Trae CN & deepseek.com & flycursor & cursor 提供的免费ai工具   
访问地址：<https://raricy.com>  
（持续更新中）    
（不要攻击我呜呜呜，谢谢啦）

有任何建议，请联系我：   
<https://raricy.com/contact>

---

以下为旧版 README.md，其中的内容可能有误或已经过时

---

## 运行要求

### 环境   
安装必要的库：   
```bash
pip install -r requirements.txt 
```

### instance   
需要创建instance文件夹，结构示例：

```
  instance
  ├── avatars
  ├── database
  ├── stories
  │   ├── mainstories_batch1
  │   │   ├── info.json
  │   │   ├── teststory1.md
  │   │   └── teststory2.md
  │   ├── mainstories_batch2
  │   │   ├── info.json
  │   │   ├── teststory3.md
  │   │   └── teststory4.md
  │   └── mainstories_batch3
  │       ├── info.json
  │       ├── teststory5.md
  │       └── teststory6.md
  └── blogs
```

可以手动创建，也可以自动创建。   
运行 `python check_instance.py` 可以自动创建四个文件夹。   

#### stories   
故事需要网站管理员手动放在 `instance` 下
`stories` 文件夹下，每个文件夹相当于一个“小说集”。   
每个小说集，需要一个 `info.json` 。示例：   
```json
{
    "title": "其它小说",
    "name": "转载/代发",
    "details": "聪明山朋友的原创故事。",
    "description": "在这里阅读转载的精彩小说",
    "ignore": false,
    "priority": 30
}
```   
最后会按照 `priority` 从大到小排序。如果 `ignore` 是 `true`，文章则不会显示在列表中。   
每个小说的 `markdown` 文件需要一个 `yaml` 格式的头。示例：   
```markdown
---
title: 聪明山庄
author: raricy
genre: 短篇小说
description: 小r想睡觉。帮帮它。
ignore: false
priority: 96
---

# 聪明山庄

小r住在聪明山上。

天黑了，他睡着了。
```   
注意：每段段首自动空两个中文字长度。   

#### blogs & avatars   
这部分的内容会在网站上动态生成。   
用户注册时，默认头像会自动创建并保存在 instance/avatars 里。   
用户上传时，文章会存在 instance/database/db.db 里。但是，目前会在 instance/blogs 下创建一个空的文件夹。

#### database   
初次运行时，需要先创建 database 文件夹。（或者通过 `check_instance.py` 自动创建）   
然后运行：   
```bash
flask db init   
flask db upgrade   
```   
这可以自动生成 `db.db` 。

### config   
需要创建.env配置文件：

> SQLALCHEMY_DATABASE_URI=sqlite:///../instance/database/db.db   
> SECRET_KEY=Secret_key_like_Il0veRust1145141919810abcdef   
> DEBUG=True   
> TURNSTILE_SITE_KEY=your_site_key   
> TURNSTILE_SECRET_KEY=your_secret_key   
> TURNSTILE_AVAILABLE=False   
> CONFIG_TYPE=development

### 启动！  
> python run.py

### 管理网站   
只有 `admin` 才能管理网站。   
如果需要 `admin`，请在项目根目录运行：
```bash
flask promote-admin username   
```   
这里的 `username` 就是需要给与管理员权限的用户名。   
用户管理列表：`/auth/user_management`   
