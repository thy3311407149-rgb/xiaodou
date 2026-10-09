# Phase 8.1 前端任务

工作区：`D:\项目文件-fe`  
分支：`frontend`  
只修改 `frontend/**`。不要修改 `backend/**`、数据库迁移、API Contract 或本任务文件。

契约以 `docs/api-contract-phase-8.1.md` 为准。标记为「已实现」的行为按现网调用；标记为「待实现契约」的 Task 字段按该文档对接，不要在前端另造状态名。

## 保持不动

- 底部三个页签仍是知识库、问小豆、文件库。最右侧搜索保持禁用。
- 不增加首页、图谱或第四个页签。
- 随笔和录音仍走现有本地交互，本阶段不接后端。
- 不实现刷新恢复，不把 `taskId` 写入 `localStorage` 或 `sessionStorage`。

## 要做的事

1. 文档入口只接受 PDF。扩展名必须是 `.pdf`。不符合时不发请求，提示 `文件类型无效`。
2. 文件大小超过 20971520 字节时不发请求，提示 `文件超过大小限制`。
3. 通过校验后调用真实 `POST /api/files`，表单字段名是 `file`。开发服务器把 `/api` 代理到 `http://127.0.0.1:3000`，只改 `frontend/vite.config.ts` 的代理。不要用 Mock 返回上传成功。
4. 请求带上 `X-Request-Id`。失败时展示响应里的 `error.message`；没有响应体时展示 `请求失败`。
5. `201` 后读取 `data.task.id`，立刻查询 `GET /api/tasks/:taskId`，并在 `QUEUED` 或 `RUNNING` 期间每秒轮询一次。
6. 展示规则：
   - `QUEUED`、`RUNNING`：处理中
   - `FAILED`：失败，展示 `errorMessage`；没有则展示 `文件处理失败`
   - `SUCCEEDED`：处理完成
7. Phase 8.1 后端会把未解析任务结束为 `FAILED`，文案是 `PDF 解析尚未接入`。前端必须照实显示失败，不能把失败画成处理完成，也不能本地伪造 `SUCCEEDED`。
8. 开始新的上传、组件卸载或任务进入 `SUCCEEDED` / `FAILED` 时，清理上一个 timer。迟到的响应如果 `taskId` 不是当前任务，直接丢弃。
9. 现有三个页签、问小豆本地对话和文件库冷启动不要被这次上传改坏。

## 测试与检查

前端目前没有测试脚本。只为 PDF 校验、20MB 限制、轮询停止和过期响应丢弃增加必要测试。测试可以替身 `fetch` 来覆盖状态切换，但产品代码路径必须请求真实接口，不能保留一个默认成功的 Mock。

在 `frontend` 目录运行：

- `npm run lint`
- `npm run build`

不要新增 UI 框架、路由库或状态管理库。可以只为上述测试加入 Vitest。

## 完成标准

- 非 PDF 和超限文件不会出现在请求里。
- 合法 PDF 会看到真实的 `201` 和随后的任务轮询。
- 旧 timer 不会改写新任务的界面。
- `npm run lint` 和 `npm run build` 通过。
