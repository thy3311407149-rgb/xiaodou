# 架构

本文描述当前 `main` 源码，不描述规划中的录音和随心记。

## 运行单元

前端是一个 React 单页应用，入口在 `frontend/src/App.tsx`。它没有单独的路由库。三个底栏是知识库、问小豆和文件库。搜索按钮保持禁用。

开发服务器把 `/api` 代理到 `http://127.0.0.1:3000`。生产构建要求 `VITE_API_BASE_URL` 是公网 HTTPS 源。

后端是一个 Express 进程。`backend/app/server.ts` 先准备上传目录、初始化数据库、恢复中断任务，再启动 HTTP 服务和任务执行器。执行器与 API 在同一进程里，一次只处理一个任务。

## 数据流

```text
选择 PDF
  → POST /api/files
  → 保存文件并创建 QUEUED 任务
  → Task Executor 领取任务
  → 抽取页面文本
  → 写入 document_texts
  → 切成 text_chunks
  → Summary Agent 调用文本模型
  → 写入 summaries
  → 任务 SUCCEEDED，文件 COMPLETED
  → 前端轮询 GET /api/tasks/:taskId
  → 详情读取摘要、正文和 PDF 内容
```

模型客户端只发送文本消息到 `{LLM_BASE_URL}/chat/completions`。它不接收音频，也没有单独的语音识别配置。

## 主要接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查，响应体只有 `{ status: "ok" }` |
| POST | `/api/files` | 上传 PDF，返回文件和新建任务 |
| GET | `/api/files` | 分页列出未删除文件 |
| GET | `/api/files/:fileId` | 文件、最新任务和最新摘要 |
| GET | `/api/files/:fileId/document-text` | 按页返回正文 |
| GET | `/api/files/:fileId/content` | 原始 PDF 字节流 |
| DELETE | `/api/files/:fileId` | 软删除并移除磁盘文件 |
| GET | `/api/tasks/:taskId` | 查询任务 |
| POST | `/api/knowledge/search` | 按关键词检索分块 |
| POST | `/api/knowledge/ask` | 基于检索结果调用模型回答 |

成功体通常是 `{ requestId, data }`。失败体是 `{ error: { code, message, requestId } }`，有关联对象时才带 `fileId`、`taskId` 或 `details`。

`GET /api/files` 的 `total` 是当前页条数，不是全库总数。列表项包含存储路径。这是现有实现，不适合直接暴露到不受信任的网络。

## 任务与文件状态

任务状态：`QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`。

PDF 任务步骤：`EXTRACT_TEXT`、`SAVE_DOCUMENT_TEXT`、`CREATE_CHUNKS`、`GENERATE_SUMMARY`、`SAVE_SUMMARY`、`COMPLETED`。

文件会经过 `UPLOADED`、`EXTRACTING`、`EXTRACTED`、`SUMMARIZING`、`COMPLETED`。抽文失败是 `EXTRACTION_FAILED`，摘要失败是 `SUMMARY_FAILED`。

启动时，遗留的 `RUNNING` 任务改为 `FAILED`，说明是「任务在进程重启时中断」，不增加重试次数，也不另建任务。`QUEUED` 会再次领取。

数据库里有幂等键列和唯一索引。当前上传接口没有读取 `Idempotency-Key` 请求头。

## 数据表

初始迁移是 `backend/app/db/migrations/001_initial_schema.sql`。启动时整份执行，语句都是 `CREATE TABLE IF NOT EXISTS`。没有独立的迁移版本表。

- `files`：目前只允许 `application/pdf`
- `tasks`：目前只允许 `PROCESS_PDF`
- `document_texts`：按页保存正文
- `text_chunks`：分块，引用可以回到页码
- `summaries`：摘要、知识点 JSON 和引用 JSON，一条任务最多一份
- `operation_logs`：固定操作名

任务、正文、分块和摘要外键指向文件，硬删除时级联。产品里的删除是软删除，只把文件标为 `DELETED` 并删除磁盘文件，数据库子行仍在。

## 摘要

`SummaryAgent` 接收文本分块，不直接读取 PDF。知识点用 `sourceChunkIndexes` 指向输入分块。引用中的摘录必须是该分块里的连续原文，页码必须与分块一致。

提示词版本当前记录为 `summary-v5`。相对更早的 `summary-v4`，保留的是截断 JSON 的修复：只留下已经完整闭合的标题、摘要、知识点和引用。提示词没有强制字数或条数上限。上下文选择最多取 20 个分块、大约 6000 token，长文档不会整篇进入一次摘要。

## 尚未接到这条链路的界面

知识库里的示例录音和随心记只存在页面内存中。结束录音会放入一段写好的转写，不会调用麦克风或语音识别。重新打开页面后，这些条目消失。已保存的 PDF 会通过 `GET /api/files` 回来。

从服务端恢复的 PDF 没有任务 ID，因此不会继续轮询未完成任务。正在这次访问中上传的文件仍会轮询。

## 明确不做的安全声明

接口没有登录。CORS 使用精确来源，非生产环境允许私网来源，不使用通配符，也不携带凭证。这不能代替访问控制。
