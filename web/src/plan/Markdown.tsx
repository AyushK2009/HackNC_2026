import type { ReactNode } from 'react'

// Tiny, safe markdown renderer: #/##/### headings, paragraphs, - lists, **bold**, > quotes.
// Builds React elements (never innerHTML), so any HTML in the text is shown as plain text.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  parts.forEach((p, i) => {
    if (!p) return
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) out.push(<strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong>)
    else out.push(p.replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,;:!?])/g, '$1$2'))
  })
  return out
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: string[] = []
  let ordered = false
  let quote: string[] = []

  const flush = () => {
    const k = `b${blocks.length}`
    if (para.length) {
      blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>)
      para = []
    }
    if (list.length) {
      const items = list.map((l, i) => {
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(l)
        return task ? (
          <li key={i} className={`md-task ${task[1] === ' ' ? '' : 'done'}`}>
            <span aria-hidden>{task[1] === ' ' ? '' : '✓'}</span>
            {inline(task[2], `${k}-${i}`)}
          </li>
        ) : (
          <li key={i}>{inline(l, `${k}-${i}`)}</li>
        )
      })
      blocks.push(ordered ? <ol key={`${k}l`}>{items}</ol> : <ul key={`${k}l`}>{items}</ul>)
      list = []
    }
    if (quote.length) {
      blocks.push(<blockquote key={`${k}q`}>{inline(quote.join(' '), k)}</blockquote>)
      quote = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (!t) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      flush()
      const level = Math.min(h[1].length, 3)
      const k = `h${blocks.length}`
      const body = inline(h[2].replace(/#+\s*$/, ''), k)
      blocks.push(level === 1 ? <h3 key={k} className="md-h1">{body}</h3> : level === 2 ? <h4 key={k} className="md-h2">{body}</h4> : <h5 key={k} className="md-h3">{body}</h5>)
      continue
    }
    const li = /^[-*•]\s+(.*)$/.exec(t)
    const oli = /^\d+[.)]\s+(.*)$/.exec(t)
    if (li || oli) {
      if (para.length || quote.length || (list.length && ordered !== !!oli)) flush()
      ordered = !!oli
      list.push((li ?? oli)![1])
      continue
    }
    const q = /^>\s?(.*)$/.exec(t)
    if (q) {
      if (para.length || list.length) flush()
      quote.push(q[1])
      continue
    }
    if (list.length || quote.length) flush()
    para.push(t)
  }
  flush()
  return <div className="md">{blocks}</div>
}
