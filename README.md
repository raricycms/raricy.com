这是 聪明山 的个人网站！

powered by flask 和 bootstrap.

网址：http://raricy.com:5000

网站还在更新中。

---

如果要运行，需要一个instance文件夹。示例结构：   
> instance
> &emsp;├── database
> &emsp;├── stories
> &emsp;│&emsp;├── mainstories_batch
> &emsp;│&emsp;│&emsp;├── info.json
> &emsp;│&emsp;│&emsp;├── teststory1.md
> &emsp;│&emsp;│&emsp;└── teststory2.md
> &emsp;│&emsp;├── mainstories_batch2
> &emsp;│&emsp;│&emsp;├── info.json
> &emsp;│&emsp;│&emsp;├── teststory3.md
> &emsp;│&emsp;│&emsp;└── teststory4.md
> &emsp;│&emsp;└── mainstories_batch3
> &emsp;│&emsp;    ├── info.json
> &emsp;│&emsp;    ├── teststory5.md
> &emsp;│&emsp;    └── teststory6.md
> &emsp;└── blogs
> &emsp;&emsp;├── test1
> &emsp;&emsp;│&emsp;├── info.json
> &emsp;&emsp;│&emsp;└── content.md
> &emsp;&emsp;├── test2
> &emsp;&emsp;│&emsp;├── info.json
> &emsp;&emsp;│&emsp;└── content.md
> &emsp;&emsp;└── test3
> &emsp;&emsp;&emsp;├── info.json
> &emsp;&emsp;&emsp;└── content.md

同时需要一个.env文件。示例：
> SQLALCHEMY_DATABASE_URI=sqlite:///../instance/database/db.db   
> SECRET_KEY=l_L0ve_Rust_secretkeyhf4cn0hnfhf43b   
> DEBUG=True   
> TRUNSTILE_SITE_KEY=some_secret_key   
> TRUNSITLE_SECRET_KEY=some_secret_key   
> TURNSTILE_AVAILABLE=False
> CONFIG_TYPE=development

