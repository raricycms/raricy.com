# 前端 Markdown 渲染全功能测试

这是一篇用于测试前端 Markdown 渲染系统的示例文章，包含各种语法和安全测试。

## 基础文本格式

**粗体文本** 和 *斜体文本* 以及 ***粗斜体文本***

~~删除线文本~~ 和 `行内代码`

> 这是一个引用块
> 
> 可以包含多行内容

## 列表功能

### 无序列表
- 项目 1
- 项目 2
  - 嵌套项目 2.1
  - 嵌套项目 2.2
- 项目 3

### 有序列表
1. 第一步
2. 第二步
   1. 子步骤 2.1
   2. 子步骤 2.2
3. 第三步

### 任务列表
- [x] 完成的任务
- [ ] 待完成的任务
- [x] 另一个完成的任务

## 代码块测试

### Python 代码
```python
def fibonacci(n):
    """计算斐波那契数列"""
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

# 测试代码
for i in range(10):
    print(f"fibonacci({i}) = {fibonacci(i)}")
```

### JavaScript 代码
```javascript
// 异步函数示例
async function fetchData(url) {
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching data:', error);
        throw error;
    }
}

// 使用示例
fetchData('/api/users')
    .then(users => console.log(users))
    .catch(err => console.error(err));
```

### SQL 代码
```sql
-- 复杂查询示例
SELECT 
    u.username,
    COUNT(b.id) as blog_count,
    AVG(b.likes_count) as avg_likes
FROM users u
LEFT JOIN blogs b ON u.id = b.author_id
WHERE u.created_at >= '2023-01-01'
GROUP BY u.id, u.username
HAVING COUNT(b.id) > 5
ORDER BY avg_likes DESC
LIMIT 10;
```

### Bash 脚本
```bash
#!/bin/bash
# 自动部署脚本

set -e

echo "开始部署..."

# 拉取最新代码
git pull origin main

# 安装依赖
pip install -r requirements.txt

# 运行数据库迁移
flask db upgrade

# 重启服务
sudo systemctl restart myapp

echo "部署完成！"
```

## 数学公式测试

### 行内公式
这是一个行内公式：$E = mc^2$，爱因斯坦的质能方程。

圆的面积公式：$A = \pi r^2$

二次方程求解：$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

### 块级公式

欧拉恒等式：
$$e^{i\pi} + 1 = 0$$

麦克斯韦方程组：
$$\begin{align}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\epsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0\mathbf{J} + \mu_0\epsilon_0\frac{\partial \mathbf{E}}{\partial t}
\end{align}$$

矩阵示例：
$$\mathbf{A} = \begin{pmatrix}
a_{11} & a_{12} & \cdots & a_{1n} \\
a_{21} & a_{22} & \cdots & a_{2n} \\
\vdots & \vdots & \ddots & \vdots \\
a_{m1} & a_{m2} & \cdots & a_{mn}
\end{pmatrix}$$

积分公式：
$$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$

求和公式：
$$\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}$$

## 表格测试

| 功能 | 状态 | 描述 | 优先级 |
|------|------|------|--------|
| Markdown 解析 | ✅ 完成 | 使用 marked.js | 高 |
| 代码高亮 | ✅ 完成 | 使用 highlight.js | 高 |
| 数学公式 | ✅ 完成 | 使用 KaTeX | 中 |
| XSS 防护 | ✅ 完成 | 使用 DOMPurify | 高 |
| 主题切换 | ✅ 完成 | 深色/亮色模式 | 低 |

## 链接和图片测试

### 外部链接
- [Google](https://www.google.com) - 应该在新窗口打开
- [GitHub](https://github.com) - 外部链接测试

### 内部链接
- [返回首页](/) - 内部链接测试

### 图片（如果有的话）
![测试图片](https://via.placeholder.com/400x200?text=Test+Image)

## XSS 安全测试

⚠️ **以下内容用于测试 XSS 防护，应该被安全过滤：**

### 基础脚本注入测试
```html
<script>alert('XSS Test')</script>
```

### 事件处理器注入
```html
<img src="x" onerror="alert('XSS')">
<div onclick="alert('XSS')">点击我</div>
```

### 伪协议注入
```html
<a href="javascript:alert('XSS')">恶意链接</a>
<iframe src="javascript:alert('XSS')"></iframe>
```

### 样式注入
```html
<div style="background-image:url(javascript:alert('XSS'))">样式注入</div>
```

### 复杂混合注入
```html
<svg onload="alert('XSS')">
<object data="javascript:alert('XSS')">
<embed src="javascript:alert('XSS')">
```

如果安全系统工作正常，以上所有恶意代码都应该被清理或无效化。

## 特殊字符测试

### HTML 实体
- &lt; &gt; &amp; &quot; &#39;
- 版权符号：&copy; 商标符号：&trade;
- 数学符号：&alpha; &beta; &gamma; &delta;

### Unicode 字符
- 表情符号：😀 😃 😄 😁 😆 🤣 😂
- 特殊符号：★ ☆ ♠ ♣ ♥ ♦
- 箭头：← → ↑ ↓ ↖ ↗ ↘ ↙

## 高级 Markdown 语法

### 详情折叠
<details>
<summary>点击展开详细内容</summary>

这是折叠的内容区域。

可以包含任何 Markdown 语法：

- 列表项
- **粗体文本**
- `代码`

```python
print("Hello from details!")
```
</details>

### 脚注（如果支持）
这是一个包含脚注的段落[^1]。

[^1]: 这是脚注的内容。

### 上标和下标
- 上标：x² 或者 x^2^
- 下标：H₂O 或者 H~2~O

## 长文本测试

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.

## 测试总结

如果您能看到：
1. ✅ 正确的文本格式化
2. ✅ 语法高亮的代码块（带复制按钮）
3. ✅ 正确渲染的数学公式
4. ✅ 整齐的表格
5. ✅ 所有 XSS 测试都被安全过滤
6. ✅ 外部链接有正确的安全属性

那么前端 Markdown 渲染系统就工作正常了！🎉

---

*测试文章结束。如有任何渲染问题，请检查浏览器控制台的错误信息。*
