# 录音实时转写接口契约

本文供前端并行开发。前端只连接本后端，不连接阿里云，不读取 `ASR_API_KEY`。

实时通道传输的是**一条连续的单声道 PCM 流**。每个 Recording 在同一时刻只有一条流。不要把每个 MediaRecorder WebM 分片当成一次独立识别，也不要把 WebM 改名为 Ogg。

## 音频格式

| 项 | 值 |
| --- | --- |
| 编码 | 16-bit signed little-endian PCM |
| 声道 | 1 |
| 采样率 | 客户端实际输出采样率，会话开始时声明一次 |
| 封装 | 无。二进制帧就是裸 PCM，不是 WebM、WAV 或 Ogg |
| 推荐帧长 | 100ms。16kHz 单声道为 3200 字节 |

百炼 `paraformer-realtime-v2` 接受 pcm、wav、mp3、opus、speex、aac、amr。opus / speex 必须是 Ogg。WebM 不在其中。

后端会检查字节。`audio/webm` 或 `audio/webm;codecs=opus` 只保存原始文件，不会送给 ASR，也不会被声明成 `pcm` 或 `opus`。采样率以会话声明值或容器头为准；容器头与声明值不一致时拒绝识别，不会只改字段。

送给百炼的 PCM 会按声明采样率做线性重采样，变成 16000 Hz 单声道 16-bit。磁盘上的分片仍是客户端原始 PCM，`session.ready.sampleRate` 也是客户端采样率。时间戳仍按原始音频时长计算。这是样本转换，不是只修改 `sample_rate` 字段。

AudioContext.sampleRate 不能当作 MediaRecorder 文件的采样率。PCM 路径使用 AudioWorklet 实际输出的采样率。

## REST

已有接口保持不变。

- `GET /api/recordings?page=1&pageSize=20` 按 `createdAt` 倒序返回历史录音。不触发识别、摘要或知识点生成。已删除的录音不出现。`page` 从 1 开始，`pageSize` 最大 100，默认 20。
- `POST /api/recordings` `{ title? }` → `201` `{ recording, knowledgeItemId }`
- `POST /api/recordings/:id/start` → 状态 `RECORDING`。此时还不连接 ASR。
- `POST /api/recordings/:id/chunks` multipart：`audio`、`sequence`、可选 `sampleRate`。先落盘，再决定是否送入当前 ASR 会话。
- `GET /api/recordings/:id` 返回录音、分片元数据、已确认转写、当前摘要、知识点、最近任务。不触发新的模型调用。
- `GET /api/recordings/:id/chunks/:sequence` 返回原始分片字节。
- `POST /api/recordings/:id/pause` 仅 `RECORDING`。停止接收新音频，结束当前 ASR 会话并保存已确认转写，状态改为 `PAUSED`。
- `POST /api/recordings/:id/resume` 仅 `PAUSED`。状态回到 `RECORDING`。下一段音频会新开 ASR 会话，转写时间戳在已有音频时长之后继续。
- `POST /api/recordings/:id/finish` `RECORDING`、`PAUSED` 或 `INTERRUPTED`。先完成 ASR `finish-task` 并等到 `task-finished`，再创建 `PROCESS_RECORDING` 任务。收尾失败时不创建任务，原始音频保留。
- `POST /api/recordings/:id/process` 结束后的显式重试。
- `DELETE /api/recordings/:id` 进行中的录音不能删除。

`sequence` 从 0 连续递增。错序、暂停期间上传、空分片都会被拒绝，已成功写入的文件不删除。

分片响应里的 `asrStatus`：`SKIPPED`（未配置识别）、`SUCCEEDED`、`FAILED`。失败时录音上有 `errorCode` 和 `errorMessage`。

列表项把录音状态和整理任务状态分开返回：

```json
{
  "items": [
    {
      "recordingId": "...",
      "title": "录音",
      "createdAt": "2026-11-08T02:41:30.009Z",
      "durationMs": 11800,
      "status": "ENDED",
      "processingStatus": "SUCCEEDED",
      "summaryGenerated": true
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

`durationMs` 是原始 PCM 时长。没有采样率或音频时为 `null`。`processingStatus` 是最近一次 `PROCESS_RECORDING` 任务的 `QUEUED`、`RUNNING`、`SUCCEEDED` 或 `FAILED`；还没有整理任务时为 `null`。`summaryGenerated` 只表示当前摘要是否已经保存。

## WebSocket

`ws://<host>/api/recordings/:recordingId/stream`

在 `POST .../start` 成功后连接。路径中的 id 就是这条录音。断开后可以用同一地址重连；服务端按下一个 `sequence` 继续。重连不重放 partial。已确认片段以 `GET /api/recordings/:id` 为准。

同一录音只保留一条流，新连接会关闭旧连接。

### 客户端消息

`session.start`：

```json
{ "type": "session.start", "sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le" }
```

`channels` 必须为 1，`encoding` 必须为 `pcm_s16le`。

音频帧二选一，同一条流里保持一种：

```json
{ "type": "audio.frame", "sequence": 0, "timestampMs": 0, "audioBase64": "<raw pcm>" }
```

或二进制帧：前 4 字节是小端 `sequence`，接着 4 字节是小端 `timestampMs`，其余是 PCM。

`timestampMs` 是客户端采集时间线，只用于对齐，不替代 ASR 返回的 `beginTime` / `endTime`。

```json
{ "type": "session.pause" }
{ "type": "session.resume" }
{ "type": "session.finish" }
```

`session.finish` 会走和 REST finish 相同的收尾，然后服务端发送 `session.completed` 并关闭连接。

百炼没有暂停指令。暂停时后端结束当前识别会话并保留已确认转写；继续时新开会话。暂停后后端拒绝新的音频帧。

### 服务端事件

`session.ready`

```json
{
  "type": "session.ready",
  "recordingId": "...",
  "format": "pcm",
  "sampleRate": 16000,
  "channels": 1,
  "encoding": "pcm_s16le"
}
```

`transcript.partial` 与 `transcript.final`：

```json
{
  "type": "transcript.partial",
  "segmentId": "partial:120",
  "text": "你好",
  "beginTime": 120,
  "endTime": 480,
  "speakerId": null,
  "isFinal": false,
  "sequence": 3
}
```

同一句未完成结果始终使用同一个 `segmentId`（`partial:` 加这段的起始时间）。前端按 `segmentId` 替换，不要追加。`transcript.final` 的 `isFinal` 为 true，并带上已保存的 `id`。`speakerId` 仅在识别结果里真有该字段时出现，否则为 null。

`asr.status`：`{ "type": "asr.status", "status": "ready" | "paused" | "unavailable" | "finishing" }`

`asr.error`：`{ "type": "asr.error", "code": "ASR_FAILED" | "ASR_UNAVAILABLE" | "INVALID_REQUEST" | "INVALID_RECORDING_STATE", "message": "..." }`

`session.completed`：`{ "type": "session.completed", "recordingId": "...", "task": { "id": "...", "status": "QUEUED", "taskType": "PROCESS_RECORDING" } }`

未配置 `ASR_API_KEY` 时不连接百炼。音频仍保存，`session.ready` 之后会收到 `asr.status = unavailable`。不会返回编造的转写。
