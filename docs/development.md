# 开发

## 环境

- Node.js 22 或更高版本。后端 `package.json` 的 `engines.node` 是 `>=22`。
- 在 `backend` 和 `frontend` 目录分别安装依赖。仓库根目录没有统一的安装脚本。

## 后端

```powershell
cd backend
copy .env.example .env
npm install
npm run dev
```

`.env` 已被忽略，不要提交。至少填写 `LLM_API_KEY`。`LLM_BASE_URL` 和 `LLM_MODEL` 按实际供应商修改。示例里的地址和模型名只是占位。

`npm run dev` 使用 `tsx watch app/server.ts`。进程启动时创建上传目录，并执行 `app/db/migrations/001_initial_schema.sql`。没有单独的迁移命令。请在 `backend` 目录启动，迁移路径相对当前工作目录。

默认地址是 `http://127.0.0.1:3000`。健康检查是 `GET /health`。

```powershell
npm test
npm run build
npm start
```

`npm test` 使用 Vitest，并关闭文件并行，避免测试共用 SQLite 时互相干扰。测试使用临时目录，不清理开发用的 `backend/data/app.db`。

## 前端

```powershell
cd frontend
npm install
npm run dev
```

本地开发不要设置 `VITE_API_BASE_URL`。Vite 把 `/api` 代理到 `http://127.0.0.1:3000`。

```powershell
npm test
npm run lint
npm run build
```

`npm run lint` 是 oxlint。`npm run build` 先执行 `tsc -b`，再执行 Vite 构建。

生产构建的 `VITE_API_BASE_URL` 必须是公网 `https` 源，例如 `https://api.example.com`。相对路径、`http`、localhost 和 `127.0.0.1` 会在发请求前被拒绝。

## 提交时不要包含

- `.env` 和任何密钥
- `backend/data/`、`backend/uploads/`、`backend/logs/`
- `node_modules/`、`dist/`、`coverage/`
- 仓库根目录的本地 PDF 和 `response-body.txt`

后端和前端的 `.env.example` 可以提交，其中的密钥必须为空。

## 目录边界

`backend/` 放接口、任务、存储和模型调用。`frontend/` 放页面和请求封装。当前行为以源码、根目录 `README.md` 和 `docs/architecture.md` 为准。
