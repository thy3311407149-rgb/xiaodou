# Phase 8.1 API Contract

状态：主工作区维护。前后端都读这一份，不各自发明响应格式。

数据库表、文件状态、任务状态、任务步骤、`operation_logs.operation` 枚举、错误码枚举都已冻结。本文件不修改它们。

## 1. 已实现

这些描述对应当前 `backend/app` 源码，不是目标行为。

### `GET /health`

`200`，`{ "status": "ok" }`。响应体没有 `requestId`。

### `POST /api/files`

- `multipart/form-data`，字段名 `file`。
- 仅接受 MIME `application/pdf` 且文件名以 `.pdf` 结尾。
- 空文件：`400`，`INVALID_REQUEST`。
- 类型不符：`400`，`INVALID_FILE_TYPE`，默认文案 `文件类型无效`。
- 超过 `MAX_FILE_SIZE_BYTES`（当前 20971520，即 20MB）：`413`，`FILE_TOO_LARGE`，默认文案 `文件超过大小限制`。
- 成功：`201`。

```json
{ "requestId": "...", "data": { "file": {} } }
```

当前实现只创建 File，`file.status` 为 `UPLOADED`。不创建 Task。响应里没有 `task`。

### `GET /api/files`

查询参数只有 `page`（默认 1）和 `pageSize`（默认 20，最大 100）。`status` 被忽略。`total` 等于本页条数。已删除文件不返回。

### `GET /api/files/:fileId`

```json
{ "requestId": "...", "data": { "file": {}, "task": null, "summary": null } }
```

`task` 和 `summary` 目前固定为 `null`。

### `DELETE /api/files/:fileId`

```json
{ "requestId": "...", "data": { "fileId": "...", "status": "DELETED" } }
```

### 错误与 RequestId

失败体：

```json
{ "error": { "code": "", "message": "", "requestId": "", "fileId": "", "taskId": "", "details": {} } }
```

`fileId`、`taskId`、`details` 仅在有值时出现。客户端可传 `X-Request-Id`；没有则服务端生成。响应头回写 `X-Request-Id`。

错误码和默认文案以 `backend/app/core/errors/error-code.ts` 为准。任务状态只允许 `QUEUED | RUNNING | SUCCEEDED | FAILED`。任务步骤只允许 `EXTRACT_TEXT | SAVE_DOCUMENT_TEXT | CREATE_CHUNKS | GENERATE_SUMMARY | SAVE_SUMMARY | COMPLETED`。

## 2. 明确尚未实现

当前源码没有：

- 上传后创建 Task
- `GET /api/tasks/:taskId`
- 进程内 Executor
- 启动时恢复中断任务

`backend/dist` 里的旧编译文件不是现有实现，不能当成已上线接口。

## 3. 待实现契约

下面全部是 Phase 8.1 要新增的行为，现在还不能当成已实现。

### 3.1 上传成功时带回 Task

`POST /api/files` 成功时仍返回 `201`，在现有 `data.file` 之外增加刚创建的任务：

```json
{
  "requestId": "...",
  "data": {
    "file": { "id": "...", "status": "UPLOADED" },
    "task": {
      "id": "...",
      "fileId": "...",
      "taskType": "PROCESS_PDF",
      "status": "QUEUED",
      "currentStep": "EXTRACT_TEXT",
      "progress": 0,
      "errorCode": null,
      "errorMessage": null,
      "startedAt": null,
      "finishedAt": null
    }
  }
}
```

File 与 Task 的数据库写入放在同一个事务里。本阶段不把 `files.status` 改成 `COMPLETED`、`EXTRACTED`、`EXTRACTING` 或 `SUMMARIZING`。上传成功后文件状态保持 `UPLOADED`。

同一文件已有 `QUEUED` 或 `RUNNING` 任务时，返回 `409` / `TASK_ALREADY_RUNNING`。这由现有唯一索引 `ux_tasks_one_active_per_file` 保证，不新增表或索引。

### 3.2 `GET /api/tasks/:taskId`

待实现。`200`：

```json
{ "requestId": "...", "data": { "task": {} } }
```

任务不存在：`404` / `TASK_NOT_FOUND`。

`task` 字段与 3.1 相同，并包含执行后的 `startedAt`、`finishedAt`、`errorCode`、`errorMessage`、`progress`。

### 3.3 文件详情中的任务

待实现：`GET /api/files/:fileId` 在已有任务时返回该文件最新一条任务，不再固定 `task: null`。`summary` 在本阶段仍然是 `null`。没有任务时 `task` 仍为 `null`。

### 3.4 Executor 的终态

待实现的执行器只证明任务能被创建、原子领取和结束。它不得接入 PDF 解析或 LLM，不得写入 `document_texts`、`text_chunks`、`summaries`，不得把未解析文件标成解析成功。

因此本阶段执行器的终态是：

- 领取：`QUEUED` 条件更新为 `RUNNING`，`changes = 1` 才算领取成功
- 结束：`FAILED`
- `errorCode = TASK_EXECUTION_FAILED`
- `errorMessage = PDF 解析尚未接入`
- `currentStep` 保持 `EXTRACT_TEXT`
- `progress` 保持 `0`
- 不得把 `status` 写成 `SUCCEEDED`
- 不得把 `currentStep` 写成 `COMPLETED`

`SUCCEEDED` 仍是冻结枚举里的合法值。查询接口必须原样返回它，但 Phase 8.1 执行器不得为了演示界面而写入它。

进程启动时，遗留的 `RUNNING` 任务改为 `FAILED`，`errorCode = TASK_EXECUTION_FAILED`，`errorMessage = 任务在进程重启时中断`，并写已有操作日志 `TASK_FAILED`。遗留的 `QUEUED` 任务重新进入领取。不新增 `operation_logs.operation` 取值；创建任务只用已有的 `TASK_CREATED`。

本阶段不包含页面刷新后的任务恢复。前端不把任务 ID 写入本地存储。
