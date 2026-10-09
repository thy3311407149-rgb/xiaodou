# Phase 8.1 后端任务

工作区：`D:\项目文件-be`  
分支：`backend`  
只修改 `backend/**`。不要修改 `frontend/**`、API Contract 或本任务文件。

契约以 `docs/api-contract-phase-8.1.md` 为准。实现其中「待实现契约」，不要把这些接口写成已经上线的旧行为。

## 禁止

- 不修改 `backend/app/db/migrations/001_initial_schema.sql`。
- 不新增表、索引或迁移。
- 不修改文件状态、任务状态、任务步骤、`operation_logs.operation` 和错误码枚举。
- 不引入 Redis、消息队列、ORM 或新的运行时依赖。
- 不接入 PDF 解析器或 LLM，不写入摘要，不生成看起来像解析结果的正文。
- 不删除或覆盖 `backend/dist`。工作区里没有这份目录是因为 Git 忽略了它，不要从主工作区拷贝后再提交。
- 不读取、不提交 `backend/.env`。本地运行需要自己的环境文件时，只从 `.env.example` 复制，并保持它不被跟踪。

## 要做的事

1. `POST /api/files` 在文件保存成功后，于同一数据库事务中创建 `PROCESS_PDF` 任务。任务初始值为 `QUEUED`、`EXTRACT_TEXT`、`progress = 0`。成功响应按契约带上 `data.task`。文件状态保持 `UPLOADED`。
2. 复用现有 `FileRepository`、`TaskRepository`、`OperationLogger` 和 `getDatabaseConnection()`。创建任务时写已有日志 `TASK_CREATED`。
3. 同一文件已有活动任务时返回 `409` / `TASK_ALREADY_RUNNING`。依赖现有部分唯一索引 `ux_tasks_one_active_per_file`，不要新建索引。事务失败时不要留下没有任务的已提交文件行；磁盘上的半成品按现有上传失败路径清理。
4. 增加轻量进程内 Executor，由 `server.ts` 在数据库初始化之后启动。领取必须是条件更新：

   `UPDATE tasks SET status = 'RUNNING' ... WHERE id = ? AND status = 'QUEUED'`

   只有 `changes = 1` 才继续处理。不要用先查再改。
5. 领取成功后不要解析 PDF。将任务结束为 `FAILED`，`errorCode = TASK_EXECUTION_FAILED`，`errorMessage = PDF 解析尚未接入`，`currentStep` 仍是 `EXTRACT_TEXT`，`progress` 仍是 `0`。写已有日志 `TASK_FAILED`。
6. 禁止插入 `document_texts`、`text_chunks`、`summaries`。禁止把文件改为 `COMPLETED`、`EXTRACTED`、`EXTRACTING` 或 `SUMMARIZING`。禁止写入 `SUCCEEDED` 或步骤 `COMPLETED`。
7. 实现 `GET /api/tasks/:taskId`。不存在时返回 `404` / `TASK_NOT_FOUND`。响应形状见契约。
8. `GET /api/files/:fileId` 返回该文件最新任务；没有任务时 `task` 仍为 `null`。`summary` 保持 `null`。
9. 启动恢复：把遗留 `RUNNING` 任务更新为 `FAILED`，`errorMessage = 任务在进程重启时中断`，并写 `TASK_FAILED`。遗留 `QUEUED` 任务交给 Executor 领取。恢复也使用条件更新，避免两个流程同时领走同一条任务。

## 测试

沿用现有 Vitest 和 Supertest，补上这些用例：

- 上传 `201` 同时存在 `UPLOADED` 文件和 `QUEUED` 任务，响应含 `data.task.id`。
- 活动任务冲突返回 `409`。
- 条件领取只有一次成功；第二次 `changes` 不是 1。
- Executor 结束后任务为 `FAILED`，错误文案是 `PDF 解析尚未接入`，且 `summaries`、`document_texts`、`text_chunks` 行数为 0，文件状态仍是 `UPLOADED`。
- `GET /api/tasks/:taskId` 返回该任务；未知 ID 返回 `404`。
- 启动时 `RUNNING` 任务变为中断失败，`QUEUED` 任务会被再次领取。
- 操作日志里有 `TASK_CREATED` 和 `TASK_FAILED`。

在 `backend` 目录运行 `npm test` 和 `npm run build`。两个都要通过。现有文件 API 测试不能回退。

## 完成标准

一份 PDF 上传后能查到真实任务，任务以「尚未解析」失败结束，数据库里没有伪造的摘要或正文。
