import { useState } from 'react'

type SourceType = 'voice' | 'note' | 'doc'
type CardKind = 'theme' | 'pillar' | 'gap'

type PanoSource = {
  id: string
  type: SourceType
  label: string
  cite: string
}

type PanoCard = {
  id: string
  kind: CardKind
  title: string
  brief: string
  thesis: string
  points: string[]
  sources: PanoSource[]
}

const panoramaCards: PanoCard[] = [
  {
    id: 'theme',
    kind: 'theme',
    title: '认知负荷与现代知识组织系统',
    brief: '工作记忆有限；可持续的专家权，来自把知识外化并结构化。',
    thesis: '你近期的录音、笔记与文档，正共同指向同一条主线：工作记忆有限，真正可持续的专家权来自把知识外化并结构化。把课堂里的判断沉淀成可检索资产，比反复整段回听更能形成复用。',
    points: [
      '外在负荷会挤占瞬时加工，材料难度并非唯一瓶颈。',
      '知识外化后，影响力不再依赖当场表现。',
      '组块化与样例路径，是新手最低成本的迁移方式。',
    ],
    sources: [
      { id: 'v1', type: 'voice', label: '第3讲录音', cite: '第3讲录音 · 12:40' },
      { id: 'n1', type: 'note', label: '课堂小记', cite: '课堂小记 · 笔记摘录' },
      { id: 'd1', type: 'doc', label: 'Sweller.pdf', cite: 'Sweller.pdf · 第 14 页' },
    ],
  },
  {
    id: 'p-load',
    kind: 'pillar',
    title: '工作记忆瓶颈',
    brief: '学习效果更取决于瞬时加工是否被外在负荷挤占。',
    thesis: '学习效果不只取决于材料难度，更取决于瞬时加工是否被外在负荷挤占。',
    points: [
      '先削减呈现方式带来的外在负荷，把有限容量留给真正需要建构的内容。',
      '把复杂材料拆成可核验的小块，再按需回跳原文核对。',
    ],
    sources: [
      { id: 'd1', type: 'doc', label: 'Sweller.pdf', cite: 'Sweller.pdf · 第 14 页' },
      { id: 'v1', type: 'voice', label: '第3讲录音', cite: '第3讲录音 · 08:12' },
    ],
  },
  {
    id: 'p-expert',
    kind: 'pillar',
    title: '专家权与知识外化',
    brief: '知识成为可调用资产时，专家权才更稳定。',
    thesis: '影响力不依赖当场表现；当知识成为可调用资产，专家权才更稳定。',
    points: [
      '外化成可检索笔记后，他人也能按路径复用，影响力不再押在临场发挥。',
      '专家权来自持续可用的知识资产，而非瞬时表达。',
    ],
    sources: [
      { id: 'v1', type: 'voice', label: '第3讲录音', cite: '第3讲录音 · 18:05' },
      { id: 'n1', type: 'note', label: '课堂小记', cite: '课堂小记 · 金句摘录' },
    ],
  },
  {
    id: 'p-chunk',
    kind: 'pillar',
    title: '组块化与样例路径',
    brief: '完整样例降低试误，是新手最省力的迁移方式。',
    thesis: '把复杂步骤压成可提取单元，用完整样例降低试误搜索，是新手最省力的迁移方式。',
    points: [
      '完整样例比直接硬解更能减少无效搜索与试误负荷。',
      '组块一旦形成，复习与迁移的成本会显著下降。',
    ],
    sources: [
      { id: 'd1', type: 'doc', label: 'Sweller.pdf', cite: 'Sweller.pdf · 第 22 页' },
      { id: 'n1', type: 'note', label: '作业备忘', cite: '作业备忘 · 步骤拆解' },
    ],
  },
  {
    id: 'gap',
    kind: 'gap',
    title: '逻辑未闭环的两处空白',
    brief: '主线已清晰，仍有两条链条未合拢，补上后复用更高。',
    thesis: '当前知识网已经能讲清主线，但仍有两条链条尚未合拢，补上后复用效率会更高。',
    points: [
      '还缺少一条把「社会认同实验」落到可引用证据的完整链条。',
      '组块化方法尚未与你自己的第二大脑工作流做一次对照验证。',
    ],
    sources: [
      { id: 'n1', type: 'note', label: '课堂小记', cite: '课堂小记 · 待补证据' },
      { id: 'd1', type: 'doc', label: 'Sweller.pdf', cite: 'Sweller.pdf · 相关章节' },
    ],
  },
]

function metaLabel(kind: CardKind) {
  if (kind === 'gap') return '✦ 逻辑空白补全'
  if (kind === 'pillar') return '✦ 知识支柱提炼'
  return '✦ 核心主线归纳'
}

function railKind(kind: CardKind) {
  if (kind === 'gap') return '逻辑空白'
  if (kind === 'pillar') return '知识支柱'
  return '知识主线'
}

function capsuleLabel(type: SourceType) {
  if (type === 'voice') return '录音'
  if (type === 'doc') return '文档'
  return '小记'
}

function sourceCapsules(sources: PanoSource[]) {
  const seen = new Set<SourceType>()
  const capsules: PanoSource[] = []
  for (const source of sources.slice(0, 3)) {
    if (seen.has(source.type)) continue
    seen.add(source.type)
    capsules.push(source)
  }
  return capsules
}

function padIndex(index: number) {
  return String(index).padStart(2, '0')
}

export function KnowledgePanorama({ onSource }: { onSource: (message: string) => void }) {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const card = panoramaCards[index]
  const total = padIndex(panoramaCards.length)
  const current = padIndex(index + 1)

  return (
    <section className="page pano-page" aria-label="知识全景">
      <div className="pano-stage">
        <div className="pano-stage-main">
          <p className="pano-progress" aria-live="polite">
            <b>{current}</b>
            <span> / {total}</span>
          </p>
          <article className={`pano-card kind-${card.kind}`} onClick={() => setOpen(true)}>
            <div className="pano-meta">
              <span className="pano-meta-l">{metaLabel(card.kind)}</span>
            </div>
            <h3>{card.title}</h3>
            <p className="pano-brief">{card.brief}</p>
            <ul className="pano-points">
              {card.points.slice(0, 3).map((point) => (
                <li key={point} className={card.kind === 'gap' ? 'gap' : undefined}>{point}</li>
              ))}
            </ul>
            <div className="pano-card-foot">
              <div className="pano-sources">
                {sourceCapsules(card.sources).map((source) => (
                  <button
                    className={`pano-src ${source.type}`}
                    key={source.type}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onSource(source.cite || source.label)
                    }}
                  >
                    {capsuleLabel(source.type)}
                  </button>
                ))}
              </div>
              <button
                className="pano-expand"
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setOpen(true)
                }}
              >
                轻触查看完整推演
              </button>
            </div>
          </article>
        </div>
        <aside className="pano-rail" aria-label="主题卡速览">
          {panoramaCards.map((item, itemIndex) => {
            const selected = itemIndex === index
            return (
              <button
                className={`pano-thumb${selected ? ' on' : ''}`}
                key={item.id}
                type="button"
                aria-current={selected ? 'true' : undefined}
                aria-label={`速览 ${padIndex(itemIndex + 1)} ${item.title}`}
                onClick={() => setIndex(itemIndex)}
              >
                <span className="pano-thumb-head">
                  <span className="pano-thumb-idx">{padIndex(itemIndex + 1)}</span>
                  <span className="pano-thumb-kind">{railKind(item.kind)}</span>
                </span>
                <span className="pano-thumb-title">{item.title}</span>
                <span className="pano-thumb-brief">{item.brief}</span>
                <span className="pano-thumb-foot" aria-hidden="true">
                  {sourceCapsules(item.sources).map((source) => (
                    <span className="pano-thumb-chip" key={source.type}>{capsuleLabel(source.type)}</span>
                  ))}
                </span>
              </button>
            )
          })}
        </aside>
      </div>
      {open && <PanoramaDetail card={card} onClose={() => setOpen(false)} onSource={onSource} />}
    </section>
  )
}

function PanoramaDetail({ card, onClose, onSource }: {
  card: PanoCard
  onClose: () => void
  onSource: (message: string) => void
}) {
  return (
    <div className="pano-reader" role="dialog" aria-modal="true" aria-label={card.title}>
      <div className="pano-reader-bar">
        <button className="pano-reader-back" type="button" autoFocus onClick={onClose}>‹ 返回</button>
      </div>
      <div className="pano-reader-body">
        <p className="pano-meta-l">{metaLabel(card.kind)}</p>
        <h2>{card.title}</h2>
        <p className="pano-thesis">{card.thesis}</p>
        <ul className="pano-detail-points">
          {card.points.map((point) => <li key={point}>{point}</li>)}
        </ul>
        <div className="pano-reader-sources">
          {card.sources.map((source) => (
            <button
              className={`pano-src ${source.type}`}
              key={`${source.id}-${source.cite}`}
              type="button"
              onClick={() => onSource(source.cite || source.label)}
            >
              {source.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
