# Nov. | 个人嵌入式知识库

> 面向嵌入式软件工程师的纯本地知识库网站，用于管理 Markdown 学习笔记。  
> 原名「嵌入式开发学习笔记」，现更名为 **Nov.**

---

## 项目简介

记录芯片调试、底层驱动、RTOS、通信协议、项目踩坑问题与解决方案。

- **零后端**：纯前端静态方案，HTML + CSS + ES Modules
- **零依赖**：无任何第三方库（无 npm install，无 CDN）
- **本地存储**：数据保存在浏览器 IndexedDB，离线可用
- **Markdown 渲染**：自定义解析器，支持 C/C++/汇编/Python/Shell 语法高亮
- **全文搜索**：标题 + 内容 + 标签多维度检索
- **暗色主题**：默认暗色模式，一键切换亮色

## 目录结构

```
embedded-notes/
├── index.html                  # 入口页面
├── css/
│   └── main.css                # 全局样式（CSS 变量驱动双主题）
├── js/
│   ├── app.js                  # 应用主入口（初始化、路由、组件协调）
│   ├── core/
│   │   ├── db.js               # IndexedDB 存储引擎
│   │   ├── markdown.js         # Markdown 渲染器（含语法高亮）
│   │   ├── search.js           # 全文搜索引擎
│   │   └── theme.js            # 明暗主题切换
│   ├── components/
│   │   ├── header.js           # 顶部导航栏（搜索、导入、关于）
│   │   ├── sidebar.js          # 侧边栏（分类树、笔记列表）
│   │   ├── editor.js           # Markdown 在线编辑器
│   │   └── views/
│   │       ├── home.js         # 首页视图
│   │       └── note.js         # 笔记阅读视图
│   └── data/
│       └── example-data.js     # 示例数据（首次启动自动导入）
└── README.md                   # 本文档
```

## 快速开始

### 方式一：直接双击打开

```bash
# 进入项目目录，直接双击 index.html 即可在浏览器中打开
```

> 注意：部分浏览器（如 Chrome）对 `file://` 协议的 ES Modules 有跨域限制。如遇 `CORS policy` 错误，请使用方式二。

### 方式二：本地 HTTP 服务器（推荐）

```bash
# 使用 Python 3（最简单）
cd embedded-notes
python -m http.server 8080

# 浏览器访问 http://localhost:8080
```

```bash
# 或使用 Node.js 的 npx
cd embedded-notes
npx serve .
```

```bash
# 或使用 VS Code Live Server 插件
# 右键 index.html → Open with Live Server
```

## 使用指南

### 1. 新增分类

点击侧边栏右上角 **`+`** 按钮，输入分类名称（如「RISC-V 学习笔记」），回车确认。

也可在侧边栏点击已有分类旁的 **✎** 按钮重命名，**✕** 按钮删除。

### 2. 新建笔记

- 点击侧边栏右上角 **📄** 按钮 → 选择分类 → 在编辑器中编写 Markdown → 点击 **保存**（或 `Ctrl+S`）
- 或在某个分类下点击 **`+ 新建笔记`**，自动关联到该分类

### 3. 导入本地 .md 文件

点击顶部导航栏的 **📥 导入按钮**，选择本地 `.md` 文件（支持多选），自动导入到第一个分类中。

### 4. 搜索笔记

- 点击顶部搜索框，或按 `Ctrl+K` 快捷键
- 输入关键词，支持标题、内容、标签全文检索
- 点击搜索结果直接跳转

### 5. 编辑笔记

打开笔记后，点击 **编辑** 按钮进入编辑器，修改后点击 **保存**（或 `Ctrl+S`）。

### 6. 明暗主题切换

点击顶部导航栏右侧的 🌙/☀️ 图标切换。首次访问默认暗色，偏好自动保存到本地。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + K` | 聚焦搜索框 |
| `Ctrl + S` | 编辑器中保存笔记 |
| `Escape` | 关闭弹窗 / 搜索下拉 |
| `Tab` | 编辑器中插入 2 个空格 |

## Markdown 语法支持

### 基础语法

- 多级标题（`#` ~ `######`）
- 粗体、斜体、删除线
- 有序/无序列表
- 引用块、分割线
- 表格、图片、链接
- 行内代码 `` `code` ``

### 代码块语法高亮

````markdown
```c
// C 语言代码
void HAL_Init(void) {}
```

```cpp
// C++ 代码
std::vector<int> v;
```

```asm
; 汇编代码
MOV R0, #0
```

```python
# Python 脚本
print("hello")
```

```shell
# Shell 命令
make flash
```

```log
[INFO] System initialized
[ERROR] SPI timeout
```
````

### 日志颜色高亮

使用 `` ```log `` 代码块，自动为以下关键词着色：

- 🔴 `ERROR` / `ERR` / `FATAL` / `FAIL` / `TIMEOUT` / `DISABLE` → 红色
- 🟡 `WARN` / `WARNING` / `BUSY` / `RESET` → 橙色
- 🟢 `INFO` / `OK` / `PASS` / `SET` / `ENABLE` → 绿色
- 🔵 `DEBUG` / `DBG` → 蓝色
- 🟣 `HAL_` / `GPIO` / `UART` / `SPI` / `I2C` / `DMA` 等嵌入式关键词 → 紫色

## 自定义配色

编辑 `css/main.css` 中的 CSS 变量即可：

```css
/* 暗色主题变量 */
[data-theme="dark"] {
  --bg-primary: #0d1117;     /* 主背景 */
  --accent: #58a6ff;          /* 主题色（蓝色） */
  --kw-color: #ff7b72;        /* 代码关键字颜色 */
  /* ... 更多变量见文件顶部 */
}

/* 亮色主题变量 */
[data-theme="light"] {
  --bg-primary: #ffffff;
  --accent: #0969da;
  /* ... */
}
```

## 数据备份与恢复

### 导出数据

在浏览器开发者工具 Console 中执行：

```javascript
import('./js/core/db.js').then(m => m.db.exportAll().then(console.log));
```

或直接备份浏览器 IndexedDB 数据。

### 导入数据

通过导航栏 📥 按钮导入 `.md` 文件。如需从 JSON 恢复，可在 Console 中执行对应写入操作。

## 技术架构

```
┌──────────────────────────────────────────────────┐
│                    index.html                     │
├──────────────────────────────────────────────────┤
│  app.js (主入口 / 路由 / 组件协调)                 │
├──────────┬──────────┬──────────┬─────────────────┤
│ sidebar  │  header  │  editor  │  views/home     │
│ .js      │  .js     │  .js     │  views/note.js  │
├──────────┴──────────┴──────────┴─────────────────┤
│  core/db.js  ←  IndexedDB 持久化存储             │
│  core/markdown.js  ←  自定义 Markdown 渲染器     │
│  core/search.js  ←  全文搜索引擎                 │
│  core/theme.js  ←  主题切换                      │
└──────────────────────────────────────────────────┘
```

## 常见问题

### Q: 刷新页面后笔记还在吗？
A: 在。所有数据存储在浏览器 IndexedDB 中，刷新/关闭浏览器后数据保留。但清除浏览器数据会丢失，建议定期导出备份。

### Q: 支持直接读取本地文件夹的 .md 文件吗？
A: 当前方案通过 IndexedDB 存储文本（方案②）。如需直接读取本地文件夹（方案①），需通过本地 HTTP 服务配合 `fetch` 读取，或使用 Electron 打包为桌面应用。

### Q: 能否在手机上使用？
A: 可以。响应式布局已适配移动端，侧边栏在手机上自动变为抽屉式。

### Q: 数据是否安全？
A: 纯本地运行，数据不上传任何服务器。

## 扩展建议

未来可扩展的方向：

- [ ] Mermaid 流程图/时序图渲染（调试时序、状态机可视化）
- [ ] 标签系统与标签云
- [ ] 笔记收藏/置顶功能
- [ ] 导出为 PDF
- [ ] Markdown 实时预览（分栏编辑）
- [ ] 拖拽排序分类和笔记
- [ ] 导入时自动解析 YAML front matter
- [ ] Git 同步备份（将笔记推送到本地 Git 仓库）

## License

个人项目，自由使用。
