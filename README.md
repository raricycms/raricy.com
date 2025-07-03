这是 聪明山 的个人网站！

powered by flask 和 bootstrap.

网址：http://raricy.com:5000

网站还在更新中。

---

如果要运行，需要一个instance文件夹。示例结构：   
> instance   
> ├── database   
> └── stories   
> &emsp;&emsp;└── mainstories_batch   
> &emsp;&emsp;&emsp;&emsp;├── info.json   
> &emsp;&emsp;&emsp;&emsp;├── teststory1.md   
> &emsp;&emsp;&emsp;&emsp;└── teststory2.md

同时需要一个.env文件。示例：
> SQLALCHEMY_DATABASE_URI=sqlite:///../instance/database/db.db   
> SECRET_KEY=I_Love_Rust   
> DEBUG=True   
> TRUNSTILE_SITE_KEY=some_secret_key   
> TRUNSITLE_SECRET_KEY=some_secret_key   
