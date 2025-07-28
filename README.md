这是聪明山的个人网站！

基于Flask和Bootstrap构建  
访问地址：http://raricy.com:5000  
（持续更新中）

---

## 运行要求
需要创建instance文件夹，结构示例：

> instance
> &emsp;├── avatars
> &emsp;├── database
> &emsp;├── stories
> &emsp;│&emsp;├── mainstories_batch
> &emsp;│&emsp;│&emsp;├── info.json
> &emsp;│&emsp;│&emsp;├── teststory1.md
> &emsp;│&emsp;│&emsp;└── teststory2.md
> 
> &emsp;│&emsp;├── mainstories_batch2
> &emsp;│&emsp;│&emsp;├── info.json
> &emsp;│&emsp;│&emsp;├── teststory3.md
> &emsp;│&emsp;│&emsp;└── teststory4.md
> 
> &emsp;│&emsp;└── mainstories_batch3
> &emsp;│&emsp;    ├── info.json
> &emsp;│&emsp;    ├── teststory5.md
> &emsp;│&emsp;    └── teststory6.md
> 
> &emsp;└── blogs
> &emsp;&emsp;├── test1
> &emsp;&emsp;│&emsp;├── info.json
> &emsp;&emsp;│&emsp;└── content.md
> 
> &emsp;&emsp;├── test2
> &emsp;&emsp;│&emsp;├── info.json
> &emsp;&emsp;│&emsp;└── content.md
> 
> &emsp;&emsp;└── test3
> &emsp;&emsp;&emsp;├── info.json
> &emsp;&emsp;&emsp;└── content.md

同时需要创建.env配置文件：

> SQLALCHEMY_DATABASE_URI=sqlite:///../instance/database/db.db   
> SECRET_KEY=your_secure_key_here   
> DEBUG=True   
> TURNSTILE_SITE_KEY=your_site_key   
> TURNSTILE_SECRET_KEY=your_secret_key   
> TURNSTILE_AVAILABLE=False   
> CONFIG_TYPE=development

