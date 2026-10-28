import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChangeEvent } from 'react'
import { ApiError, REQUEST_FAILED_MESSAGE } from './api/http.ts'
import { fetchStoredFiles, uploadPdf } from './api/files.ts'
import { fetchTask } from './api/tasks.ts'
import { DocumentTextViewer } from './components/DocumentTextViewer.tsx'
import { PdfViewer } from './components/PdfViewer.tsx'
import { FileSummary } from './components/SummaryCard.tsx'
import { libraryItemFromStoredFile, libraryItemFromUpload, mergeStoredFiles, withTask } from './upload/library-item.ts'
import { createUploadSession } from './upload/upload-session.ts'
import './App.css'

type Tab = 'library' | 'ask' | 'files'
type ItemType = 'voice' | 'note' | 'doc'
type ItemStatus = 'done' | 'inbox'
type LibraryItem = {
  id: string
  type: ItemType
  status: ItemStatus
  title: string
  desc: string
  time: string
  body: string
  tags: string[]
  ready?: boolean
  pct?: number
  duration?: number
  pages?: number
  fmt?: string
  upload?: {
    fileId: string
    taskId: string | null
    phase: 'processing' | 'succeeded' | 'failed'
    label: string
    detail: string | null
    progress: number | null
  }
}

const initialItems: LibraryItem[] = [
  { id: 'v1', type: 'voice', status: 'done', title: '组织行为学 · 第3讲', desc: '专家权比职位权更稳。知识外化后不依赖当场表现。', time: '今天 08:12', body: '今天讲到专家权：当你把知识外化成可检索的笔记，影响力不依赖当场表现。建议把认知负荷和组块写进第二大脑。', tags: ['组织行为学', '专家权'], duration: 186 },
  { id: 'n1', type: 'note', status: 'inbox', title: '小记', desc: '下周小组作业要用到社会认同实验。', time: '今天 08:40', body: '下周小组作业要用到社会认同实验。需要从第3讲录音里补一条证据。', tags: ['课堂', '作业'] },
  { id: 'd1', type: 'doc', status: 'done', title: '认知负荷理论_Sweller.pdf', desc: '', time: '昨天', body: '', tags: ['学习科学'], ready: true, pages: 18, fmt: 'PDF' },
  { id: 'd2', type: 'doc', status: 'inbox', title: '实习周报_第4周.docx', desc: '', time: '昨天', body: '', tags: ['工作'], ready: false, pct: 55, fmt: 'Word' },
]

const filters = [
  ['all', '全部'],
  ['note', '随笔'],
  ['voice', '录音'],
  ['doc', '文件解析'],
] as const

const insightScenes = {
  discover: {
    tag: '● AI 交叉关联发现 · 刚刚',
    title: '「认知负荷」与上周录音形成互证',
    body: '你刚上传的《认知负荷》与「组织行为学录音」在“工作记忆瓶颈”上观点高度吻合。',
    cta: '查看全景',
  },
  review: {
    tag: '● 遗忘曲线提醒 · 7 天前',
    title: '重温 7 天前的思考',
    body: '你在 9月19日 记录的关于“专家权与知识外化”的随笔，最近被引用了 3 次。',
    cta: '立即重温',
  },
} as const

const coldCopy = {
  empty: {
    title: '让知识自动形成关联',
    body: '上传文件、记录想法或保存内容后，小豆会自动发现不同内容中的相同主题，并帮你整理成知识集合。',
  },
  sparse: {
    title: '继续积累，发现更多关联',
    body: '当不同内容围绕同一主题时，小豆会自动帮你聚合，让分散的知识形成完整主题。',
  },
  'no-link': {
    title: '暂时没有发现相同主题',
    body: '小豆会持续分析你的知识，当发现不同内容中的共同主题时，会自动整理成主题集合。',
  },
} as const

function formatTime(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function itemMeta(item: LibraryItem) {
  if (item.type === 'doc') {
    const fmt = item.fmt ?? (/\.pdf$/i.test(item.title) ? 'PDF' : /\.docx?$/i.test(item.title) ? 'Word' : '文档')
    return [fmt, item.pages ? `${item.pages} 页` : '', item.time].filter(Boolean).join(' · ')
  }
  if (item.type === 'voice') return ['录音', item.duration != null ? formatTime(item.duration) : '', item.time].filter(Boolean).join(' · ')
  return ['笔记', item.time].filter(Boolean).join(' · ')
}

function coldKind(items: LibraryItem[]) {
  const ready = items.filter((item) => item.ready !== false).length
  if (ready === 0) return 'empty'
  if (ready < 2) return 'sparse'
  return 'no-link'
}

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<ReturnType<typeof createUploadSession> | null>(null)
  const [tab, setTab] = useState<Tab>('library')
  const [items, setItems] = useState(initialItems)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [recordOpen, setRecordOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [noteTag, setNoteTag] = useState('课堂')
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all')
  const [selected, setSelected] = useState<LibraryItem | null>(null)
  const [messages, setMessages] = useState<{ role: 'user' | 'bot'; text: string }[]>([])
  const [toast, setToast] = useState('')
  const [scene, setScene] = useState<keyof typeof insightScenes>('discover')
  const [addOpen, setAddOpen] = useState(false)
  const [citeOpen, setCiteOpen] = useState(false)
  const [cited, setCited] = useState<LibraryItem | null>(null)

  useEffect(() => {
    let active = true
    void fetchStoredFiles().then(
      (files) => {
        if (!active) return
        setItems((current) => mergeStoredFiles(current, files.map((file) => libraryItemFromStoredFile(file))))
      },
      (error: unknown) => {
        if (!active) return
        setToast(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setRecordSeconds((seconds) => seconds + 1), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const session = createUploadSession({
      upload: uploadPdf,
      getTask: fetchTask,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (id) => window.clearTimeout(id),
      listener: {
        onRejected: (message) => setToast(message),
        onUploadFailed: (message) => setToast(message),
        onAccepted: (uploaded) => {
          setItems((current) => [libraryItemFromUpload(uploaded), ...current.filter((item) => item.id !== uploaded.fileId)])
          setTab('library')
          setAddOpen(false)
        },
        onTask: (task) => {
          setItems((current) => current.map((item) => item.upload?.taskId === task.id ? withTask(item, task) : item))
        },
        onPollFailed: (message, taskId) => {
          setToast(message)
          setItems((current) => current.map((item) => item.upload?.taskId === taskId
            ? { ...item, desc: message, upload: { ...item.upload, phase: 'failed', label: '失败', detail: message } }
            : item))
        },
      },
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [])

  const filteredItems = useMemo(() => items.filter((item) => filter === 'all' || item.type === filter), [filter, items])
  const brief = insightScenes[scene]

  const saveNote = () => {
    const text = note.trim()
    if (!text) { setToast('先写一句再保存'); return }
    setItems((current) => [{ id: `n-${Date.now()}`, type: 'note', status: 'inbox', title: `小记 · ${noteTag}`, desc: text, time: '刚刚', body: text, tags: [noteTag] }, ...current])
    setNote('')
    setNoteOpen(false)
    setTab('library')
    setToast('已存入大脑')
  }

  const startRecording = () => {
    setTab('library')
    setRecordOpen(true)
    setAddOpen(false)
    if (!recording) {
      setRecordSeconds(0)
      setTranscript('')
      setRecording(true)
    }
  }

  const stopRecording = () => {
    setRecording(false)
    setTranscript('今天讲到专家权：把知识外化成可检索笔记后，影响力不依赖当场表现。建议把「认知负荷」和「组块」写进第二大脑。')
    setToast('录音已停止，可以编辑转写')
  }

  const saveTranscript = () => {
    if (!transcript.trim()) return
    setItems((current) => [{ id: `v-${Date.now()}`, type: 'voice', status: 'done', title: `录音 · ${formatTime(recordSeconds)}`, desc: transcript.slice(0, 34), time: '刚刚', body: transcript, tags: ['录音'], duration: recordSeconds }, ...current])
    setTranscript('')
    setRecordSeconds(0)
    setRecordOpen(false)
    setToast('已放入知识库')
  }

  const addFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    const name = selected.name
    const type = selected.type
    const lastModified = selected.lastModified
    void selected.arrayBuffer().then((bytes) => {
      event.target.value = ''
      const file = new File([bytes], name, { type, lastModified })
      return sessionRef.current?.submit(file)
    })
  }

  const ask = (text: string) => {
    const question = text.trim()
    if (!question) return
    const source = cited ? cited.title : question.includes('总结') ? '组织行为学 · 第3讲' : '认知负荷理论_Sweller.pdf'
    const answer = question.includes('总结')
      ? `今天第3讲核心：专家权 + 知识外化。把认知写成可检索笔记，影响力就不依赖当场表现。\n来源 · ${source}`
      : `有关。Sweller 讲外部存储能降低内在负荷；你第3讲录音把「知识外化」和专家权连在一起，可以互相引用。\n来源 · ${source}`
    setMessages((current) => [...current, { role: 'user', text: question }, { role: 'bot', text: answer }])
    setCited(null)
  }

  const openBriefAction = () => {
    if (scene === 'discover') {
      setTab('files')
      return
    }
    const noteItem = items.find((item) => item.id === 'n1') ?? items.find((item) => item.type === 'note')
    if (noteItem) setSelected(noteItem)
    else setToast('暂无可重温的笔记')
  }

  return (
    <div className={`app tab-${tab}`}>
      <div className="status-bar"><span>10:32</span><span className="right">▮▮▮ 5G</span></div>
      <header className="showcase">
        <div className="showcase-top">
          <h1>
            {tab === 'library' ? <>Hi, Tina<span className="live-dot" aria-hidden="true" /></> : tab === 'ask' ? '问小豆' : '文件库'}
          </h1>
          <button className="avatar-btn" type="button" aria-label="我的页面" onClick={() => setToast('我的页面即将开放')}>T</button>
        </div>
      </header>
      <main className="pages">
        {tab === 'library' && (
          <section className="page with-dock">
            <div className="insight-card" onClick={() => setScene((current) => current === 'discover' ? 'review' : 'discover')}>
              <span className="insight-tag">{brief.tag}</span>
              <span className="insight-title">{brief.title}</span>
              <span className="insight-body">{brief.body}</span>
              <span className="insight-foot">
                <span className="insight-dots">
                  {(Object.keys(insightScenes) as Array<keyof typeof insightScenes>).map((key) => (
                    <button className={`insight-dot ${scene === key ? 'on' : ''}`} key={key} type="button" aria-label={key === 'discover' ? '新关联发现' : '温故反刍'} onClick={(event) => { event.stopPropagation(); setScene(key) }} />
                  ))}
                </span>
                <button className="insight-cta" type="button" onClick={(event) => { event.stopPropagation(); openBriefAction() }}>{brief.cta} →</button>
              </span>
            </div>
            <div className="filter-row">
              {filters.map(([value, label]) => (
                <button className={`chip ${filter === value ? 'on' : ''}`} key={value} type="button" onClick={() => setFilter(value)}>{label}</button>
              ))}
            </div>
            <div className="lib-list">
              {filteredItems.length === 0 && <div className="empty">没有符合筛选的内容</div>}
              {filteredItems.map((item) => <ItemRow item={item} key={item.id} onSelect={setSelected} />)}
            </div>
          </section>
        )}
        {tab === 'ask' && (
          <AskPage
            messages={messages}
            cited={cited}
            citeOpen={citeOpen}
            onAsk={ask}
            onToggleCite={() => setCiteOpen((open) => !open)}
            onCite={(item) => { setCited(item); setCiteOpen(false) }}
            onClearCite={() => setCited(null)}
            onLimited={() => setToast('本版仅支持文字提问')}
            items={items}
          />
        )}
        {tab === 'files' && (
          <FileLibraryPage
            kind={coldKind(items)}
            addOpen={addOpen}
            onToggleAdd={() => setAddOpen((open) => !open)}
            onRecord={startRecording}
            onNote={() => { setAddOpen(false); setNoteOpen(true) }}
            onFile={() => fileRef.current?.click()}
          />
        )}
      </main>
      {tab === 'library' && !selected && !noteOpen && !recordOpen && (
        <div className="capture-dock" aria-label="即刻捕捉">
          <button className="dock-input" type="button" aria-label="闪念笔记" onClick={() => setNoteOpen(true)}>
            <PenIcon />
            <span>写下闪念，或开始录音...</span>
          </button>
          <div className="dock-actions">
            <button className="dock-btn dock-mic" type="button" aria-label="语音速记" onClick={startRecording}><MicIcon /></button>
            <button className="dock-btn" type="button" aria-label="解析文档" onClick={() => fileRef.current?.click()}><ClipIcon /></button>
          </div>
        </div>
      )}
      <nav className="tabbar" aria-label="底部导航">
        <div className="tabbar-dock">
          <div className="tabbar-pill" role="tablist">
            <span className={`tab-indicator ${tab}`} aria-hidden="true" />
            <TabButton active={tab === 'library'} label="知识库" onClick={() => setTab('library')}><BookIcon /></TabButton>
            <TabButton active={tab === 'ask'} label="问小豆" onClick={() => setTab('ask')}><AskIcon /></TabButton>
            <TabButton active={tab === 'files'} label="文件库" onClick={() => setTab('files')}><GlobeIcon /></TabButton>
          </div>
          <button className="tabbar-search" type="button" disabled aria-label="搜索">
            <SearchIcon />
          </button>
        </div>
      </nav>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={addFile} />
      {noteOpen && <NoteSheet note={note} noteTag={noteTag} onChange={setNote} onTag={setNoteTag} onClose={() => setNoteOpen(false)} onSave={saveNote} />}
      {recordOpen && <RecordSheet recording={recording} seconds={recordSeconds} transcript={transcript} onTranscript={setTranscript} onStop={stopRecording} onSave={saveTranscript} onClose={() => { setRecording(false); setRecordOpen(false) }} />}
      {selected && <DetailSheet item={selected} onClose={() => setSelected(null)} onToast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TabButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`tab ${active ? 'on' : ''}`} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {children}
      <span className="tab-label">{label}</span>
    </button>
  )
}

function ItemRow({ item, onSelect }: { item: LibraryItem; onSelect: (item: LibraryItem) => void }) {
  const upload = item.upload
  const processing = upload ? upload.phase === 'processing' : item.type === 'doc' && item.ready === false
  const progress = upload ? upload.progress : item.pct ?? 40
  return (
    <button className="item" type="button" onClick={() => onSelect(item)}>
      <span className="item-type-ico" aria-hidden="true">{item.type === 'voice' ? <MicIcon /> : item.type === 'note' ? <PenIcon /> : <DocIcon />}</span>
      <span className="item-copy">
        <h4>
          {item.title}
          {upload && <span className={`micro-tag ${upload.phase === 'succeeded' ? 'ok' : upload.phase === 'failed' ? 'bad' : 'run'}`}>{upload.label}</span>}
          {!upload && processing && <span className="micro-tag run">解析中</span>}
          {!upload && item.type === 'doc' && item.ready !== false && <span className="micro-tag ok">已拆解</span>}
          {!upload && item.type !== 'doc' && item.status === 'inbox' && <span className="micro-tag">待处理</span>}
        </h4>
        <p className="point">{itemMeta(item)}</p>
        {upload?.detail && <span className="upload-detail">{upload.detail}</span>}
        {processing && progress != null && (
          <span className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
      </span>
    </button>
  )
}

function AskPage({ messages, cited, citeOpen, items, onAsk, onToggleCite, onCite, onClearCite, onLimited }: {
  messages: { role: 'user' | 'bot'; text: string }[]
  cited: LibraryItem | null
  citeOpen: boolean
  items: LibraryItem[]
  onAsk: (text: string) => void
  onToggleCite: () => void
  onCite: (item: LibraryItem) => void
  onClearCite: () => void
  onLimited: () => void
}) {
  const [input, setInput] = useState('')
  const send = (text = input) => { onAsk(text); setInput('') }
  return (
    <section className="page ask-page">
      <div className="chat">
        {!messages.length && (
          <>
            <div className="ask-greet"><h2>Hi, Tina</h2><p>我是小豆，聊天、写作、搜索都在行，助你灵感无限</p></div>
            <div className="suggests">
              {['认知负荷和我的录音有什么关系？', '帮我列小组作业要用的三点', '总结今天的课堂录音'].map((suggestion) => (
                <button className="chip" type="button" key={suggestion} onClick={() => send(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </>
        )}
        {messages.map((message, index) => <Bubble key={`${message.role}-${index}`} role={message.role} text={message.text} />)}
      </div>
      {cited && <button className="cite-chip" type="button" onClick={onClearCite}>引用 · {cited.title}</button>}
      <div className="composer">
        <div className="input-pill">
          <button className="cam-btn" type="button" aria-label="拍照" onClick={onLimited}><CamIcon /></button>
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && send()} placeholder="发消息或按住说话…" />
          <div className="icon-tools">
            <button type="button" aria-label="语音" onClick={onLimited}><MicIcon /></button>
            <button type="button" aria-label="引用知识库" aria-expanded={citeOpen} onClick={onToggleCite}><MoreIcon /></button>
          </div>
        </div>
        <button className="send-btn" type="button" aria-label="发送" onClick={() => send()}><SendIcon /></button>
      </div>
      {citeOpen && (
        <div className="cite-menu" role="menu" aria-label="选择知识库内容">
          {items.slice(0, 4).map((item) => (
            <button type="button" key={item.id} role="menuitem" onClick={() => onCite(item)}>{item.type === 'voice' ? '录音' : item.type === 'note' ? '随笔' : '文件解析'} · {item.title}</button>
          ))}
        </div>
      )}
    </section>
  )
}

function Bubble({ role, text }: { role: 'user' | 'bot'; text: string }) {
  const [body, source] = text.split('\n来源 · ')
  return (
    <div className={`bubble ${role}`}>
      {body}
      {source && <span className="src">来源 · {source}</span>}
    </div>
  )
}

function FileLibraryPage({ kind, addOpen, onToggleAdd, onRecord, onNote, onFile }: {
  kind: keyof typeof coldCopy
  addOpen: boolean
  onToggleAdd: () => void
  onRecord: () => void
  onNote: () => void
  onFile: () => void
}) {
  const copy = coldCopy[kind]
  return (
    <section className="page files-page">
      <div className="pano-cold">
        <ColdVisual />
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <button className="pano-cold-cta" type="button" onClick={onToggleAdd}>+ 添加知识</button>
        {addOpen && (
          <div className="add-menu" role="menu" aria-label="添加知识">
            <button type="button" onClick={onRecord}>录音</button>
            <button type="button" onClick={onNote}>随笔</button>
            <button type="button" onClick={onFile}>文件解析</button>
          </div>
        )}
      </div>
    </section>
  )
}

function NoteSheet({ note, noteTag, onChange, onTag, onClose, onSave }: {
  note: string
  noteTag: string
  onChange: (value: string) => void
  onTag: (value: string) => void
  onClose: () => void
  onSave: () => void
}) {
  const tags = ['课堂', '作业', '灵感', '工作']
  return (
    <div className="overlay note-sheet">
      <div className="sheet">
        <div className="nc-bar">
          <button type="button" onClick={onClose}>取消</button>
          <span className="nc-title">闪念笔记</span>
          <button className="nc-done" type="button" onClick={onSave}>存入大脑</button>
        </div>
        <textarea value={note} onChange={(event) => onChange(event.target.value)} placeholder="记录这一刻的顿悟、课堂要点或火花..." />
        <div className="chips">{tags.map((tag) => <button className={`chip ${noteTag === tag ? 'on' : ''}`} key={tag} type="button" onClick={() => onTag(tag)}>{tag}</button>)}</div>
      </div>
    </div>
  )
}

function RecordSheet({ recording, seconds, transcript, onTranscript, onStop, onSave, onClose }: {
  recording: boolean
  seconds: number
  transcript: string
  onTranscript: (value: string) => void
  onStop: () => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="timer">{formatTime(seconds)}</div>
        <p className="timer-sub">{recording ? '正在录音，结束后可编辑转写' : '转写预览，可改后再放入知识库'}</p>
        {!recording && <textarea className="note" value={transcript} onChange={(event) => onTranscript(event.target.value)} />}
        {recording
          ? <button className="btn btn-primary btn-block" type="button" onClick={onStop}>结束录音</button>
          : <button className="btn btn-primary btn-block" type="button" onClick={onSave}>放入知识库</button>}
      </div>
    </div>
  )
}

function isPdfItem(item: LibraryItem) {
  return item.fmt === 'PDF' || /\.pdf$/i.test(item.title) || Boolean(item.upload)
}

function DetailSheet({ item, onClose, onToast }: { item: LibraryItem; onClose: () => void; onToast: (message: string) => void }) {
  const pdf = isPdfItem(item)
  const fileId = item.upload?.fileId ?? null
  const [panel, setPanel] = useState<'pdf' | 'text' | null>(null)
  return (
    <>
      <div className="overlay detail-overlay" onClick={onClose}>
        <div className="sheet" onClick={(event) => event.stopPropagation()}>
          <button className="back-row" type="button" onClick={onClose}>‹ 知识库</button>
          <div className="detail-card">
            <h2>{item.title}</h2>
            <p className="meta">{itemMeta(item)}{item.tags.length ? ` · ${item.tags.join(' / ')}` : ''}</p>
            {item.body && <div className="detail-body">{item.body}</div>}
            {item.upload && <p className="detail-body">{[item.upload.label, item.upload.detail].filter(Boolean).join(' · ')}</p>}
            {item.status === 'inbox' && item.type !== 'doc' && <button className="btn btn-primary btn-block" type="button" onClick={() => { onToast('已整理'); onClose() }}>标为已整理</button>}
          </div>
          {pdf && (
            <div className="detail-actions">
              <button className="btn btn-primary" type="button" onClick={() => setPanel('pdf')}>打开PDF</button>
              <button className="btn btn-ghost" type="button" onClick={() => setPanel('text')}>打开完整解析</button>
            </div>
          )}
          {pdf && (
            <div className="detail-scroll">
              <FileSummary fileId={fileId} fileName={item.title} />
            </div>
          )}
        </div>
      </div>
      {panel === 'pdf' && <PdfViewer fileId={fileId} onClose={() => setPanel(null)} />}
      {panel === 'text' && <DocumentTextViewer fileId={fileId} onClose={() => setPanel(null)} />}
    </>
  )
}

function ColdVisual() {
  return (
    <svg width="180" height="120" viewBox="0 0 220 160" fill="none" aria-hidden="true">
      <circle cx="110" cy="78" r="52" stroke="#E7E5E4" strokeWidth="1.2" strokeDasharray="3 5" />
      <circle cx="110" cy="78" r="28" fill="rgba(5,150,105,0.06)" stroke="rgba(5,150,105,0.18)" />
      <circle cx="110" cy="78" r="14" fill="#ECFDF5" stroke="#059669" strokeWidth="1.8" />
      <circle cx="110" cy="78" r="5" fill="#059669" />
    </svg>
  )
}

function PenIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.45 3.55a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5L16.45 3.55z" /></svg>
}
function MicIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 2.8a2.8 2.8 0 0 0-2.8 2.8v5.6a2.8 2.8 0 0 0 5.6 0V5.6A2.8 2.8 0 0 0 12 2.8Z" /><path d="M6.5 10.2a5.5 5.5 0 0 0 11 0" /><path d="M12 15.7v3.5" /></svg>
}
function ClipIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
}
function DocIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
}
function BookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 5.2h5.2a2 2 0 0 1 2 2v11.2c0-.8-.7-1.4-1.5-1.4H5V5.2z" /><path d="M19 5.2h-5.2a2 2 0 0 0-2 2v11.2c0-.8.7-1.4 1.5-1.4H19V5.2z" /></svg>
}
function AskIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="7.2" /><circle cx="12" cy="12" r="2.2" /></svg>
}
function GlobeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="8" /><path d="M12 4v16M4 12h16" /><ellipse cx="12" cy="12" rx="3.4" ry="8" /></svg>
}
function SearchIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.2-3.2" /></svg>
}
function CamIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3.5" /></svg>
}
function MoreIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></svg>
}
function SendIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7z" /></svg>
}

export function GraphPage({ items }: { items: LibraryItem[] }) {
  return (
    <section className="page active graph-page">
      <div className="stat-grid">
        <div className="stat"><b>{items.length + 10}</b><span>知识节点</span></div>
        <div className="stat"><b>18</b><span>关联链接</span></div>
        <div className="stat"><b>{new Set(items.flatMap((item) => item.tags)).size + 2}</b><span>主题领域</span></div>
      </div>
      <div className="graph-canvas">
        <svg viewBox="0 0 390 380" aria-label="知识关系图">
          <g stroke="#ddd7ce" strokeWidth="1.5"><path d="M190 190L75 92M190 190L312 90M190 190L74 286M190 190L318 286M190 190L190 54" /></g>
          <circle cx="190" cy="190" r="38" fill="#3a3530" />
          <text x="190" y="194" fill="white" textAnchor="middle">认知负荷</text>
        </svg>
        <div className="graph-legend"><span>核心概念</span><span>技术方法</span><span>资料来源</span></div>
        <small className="graph-hint">拖拽节点 · 点击查看</small>
      </div>
    </section>
  )
}

export default App
