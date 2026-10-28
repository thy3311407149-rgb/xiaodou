# 小豆

小豆是一个正在开发的个人知识管理产品。它要解决的问题是：PDF、笔记和录音不断堆积，但保存下来的内容很难再被理解、找回和引用。

当前版本先把 PDF 走通。用户上传一份 PDF 后，系统在后台抽取正文、生成摘要和知识点，并在知识库里保留原文定位。录音转写、随心记持久化和知识关联还在规划中，界面上能看到的录音和笔记仍是本地演示，不会写入数据库。

这是一个个人构建的 AI 产品项目，用来练习从需求拆解到前后端和 Agent 落地的完整链路。欢迎通过 Issue 讨论实现取舍。这里没有用户规模、性能基准或商业结果可以引用。

## 已实现

- 上传 PDF。只接受 `.pdf`，空文件和超过 20MB 的文件会被拒绝。
- 上传成功后在同一个事务里创建处理任务，并在进程内排队执行。
- 抽取页面文本、清洗、分块。
- 调用兼容 OpenAI Chat Completions 的文本模型，生成 Markdown 摘要、知识点和引用。
- 知识库重新打开后，从服务端读回已保存的 PDF，并查看摘要、解析正文和原始 PDF。
- 引用记录所在页码和原文片段，便于回到 PDF 核对。
- 任务状态可查询。前端在处理期间轮询任务。
- 服务重启时，遗留的运行中任务记为失败，排队中的任务会再次执行。

后端另外提供关键词检索和基于检索结果的问答接口。当前「问小豆」页面还没有调用这两个接口，页面里的对话是本地示例。

## 规划中

这些能力出现在当前界面演示里，但还没有接入持久化和真实处理：

- 录音、实时或非实时语音转写
- 随心记的保存、编辑和自动摘要
- PDF、录音、笔记进入同一种知识对象
- 知识图谱、全局搜索
- 登录、权限和公网访问控制

## 技术栈

以当前依赖和源码为准。

| 层 | 选择 |
|---|---|
| 前端 | React 19、TypeScript、Vite 8 |
| 后端 | Node.js 22 及以上、TypeScript、Express 5 |
| 数据库 | SQLite、better-sqlite3 |
| PDF | pdfjs-dist |
| 摘要展示 | react-markdown、remark-gfm |
| 模型调用 | HTTP，兼容 OpenAI `POST /chat/completions`。服务端持有密钥 |
| 测试 | Vitest。后端同时使用 Supertest |
| 前端检查 | oxlint、`tsc` |
| 上传 | multer |

没有使用 Redis、消息队列、ORM、向量数据库或独立的 ASR SDK。

## 架构

```text
React 页面
    ↓  /api
Express
    ↓
SQLite
    ↓
进程内 Task Executor
    ↓
PDF 抽文 → 分块 → Summary Agent → 写回摘要
    ↓
页面轮询任务，并读回摘要、正文和 PDF
```

更细的状态、表和限制见 [docs/architecture.md](docs/architecture.md)。本地运行见 [docs/development.md](docs/development.md)。范围见 [docs/roadmap.md](docs/roadmap.md)。

当前行为以源码和 `docs/architecture.md` 为准。

## 工程实践

这些都能在当前代码里核对，不表示系统已经可以公网生产使用。

- 成功响应使用 `{ requestId, data }`。失败响应使用稳定错误码、中文说明和同一个请求 ID。
- 客户端可以传入 `X-Request-Id`，否则服务端生成。
- 上传同时检查 MIME 和扩展名，并限制文件大小。
- 任务只有 `QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`。PDF 处理固定走抽取、保存正文、分块、生成摘要、保存摘要、完成。
- 同一文件同时只能有一个排队或运行中的任务。
- SQLite 用外键、检查约束和启动时执行的初始迁移保证表结构。迁移文件只创建尚不存在的表，不会自动改变已有表。
- 进程重启不把中断任务伪装成成功。
- 前端按任务 ID 轮询，连续失败后停止，并丢弃过期响应。
- 摘要结果保存为结构化字段：正文、知识点、引用、模型名和提示词版本。模型输出被截断时，只保留已经完整的字段。
- 接口目前没有登录。模型密钥只放在服务端环境变量中。

## 本地运行

需要 Node.js 22 或更高版本。数据库不需要单独安装，后端第一次启动时会在配置的路径创建 SQLite 文件并执行初始迁移。

```powershell
cd backend
copy .env.example .env
npm install
npm run dev
```

在 `.env` 中填写 `LLM_API_KEY`，并按供应商修改 `LLM_BASE_URL` 和 `LLM_MODEL`。示例值不是可用密钥。开发服务默认监听 `http://127.0.0.1:3000`。

另开一个终端：

```powershell
cd frontend
npm install
npm run dev
```

开发时前端请求相对路径 `/api`，由 Vite 代理到本机 3000 端口。生产构建才读取 `VITE_API_BASE_URL`，并且必须是公网 `https` 源。不要把密钥写进任何 `VITE_` 变量。

## 脚本

在 `backend` 目录：

```powershell
npm test
npm run build
npm start
```

`npm start` 运行编译后的 `dist/app/server.js`，工作目录仍应是 `backend`，因为迁移文件从当前目录读取。

在 `frontend` 目录：

```powershell
npm test
npm run lint
npm run build
```

## 配置

后端复制 `backend/.env.example`：

```text
APP_ENV=development
DATABASE_PATH=./data/app.db
UPLOAD_DIR=./uploads
MAX_FILE_SIZE_BYTES=20971520
PORT=3000
HOST=127.0.0.1
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_MS=180000
LLM_MAX_RETRIES=2
LLM_MAX_OUTPUT_TOKENS=8192
LLM_TEMPERATURE=0.2
CORS_ALLOWED_ORIGINS=
```

`CORS_ALLOWED_ORIGINS` 是逗号分隔的精确来源。带 `*` 的值会被忽略。非生产环境另外允许本机和私网来源，方便手机访问开发页。生产环境只放行名单中的来源。

前端生产构建使用 `frontend/.env.example` 里的 `VITE_API_BASE_URL`。本地开发留空。

## 目录

```text
backend/     Express API、任务执行、PDF 处理、Summary Agent、SQLite
frontend/    React 界面、上传、轮询和知识库详情
docs/        当前架构、开发和路线图
```

## 许可

项目代码采用 [MIT License](LICENSE)。版权行使用项目名「小豆」，因为仓库里没有单独的法律主体名称。

MIT 不包含产品名、产品图标和专有品牌素材。`frontend/public/favicon.svg` 与 `portfolio/assets/mark.svg` 保留权利，见 [NOTICE.md](NOTICE.md)。第三方依赖仍受各自许可证约束。

## 当前状态

PDF 上传、解析、摘要、知识库回读和原文定位可以本地跑通。录音、随心记和统一知识模型尚未开始实现。公网部署前还需要决定访问控制，当前接口没有认证。
