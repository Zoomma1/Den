// Runtime factice de test : respecte le contrat install(host, limits) d'un surface-runtime, écrit pour Den (ce n'est pas le runtime du moteur).
const flatten = (children, out) => {
  for (const c of children) {
    if (c === null || c === undefined || typeof c === 'boolean') continue
    if (Array.isArray(c)) flatten(c, out)
    else out.push(typeof c === 'number' ? String(c) : c)
  }
}
let counter = 0
export function Fragment(props) {
  return { type: 'Box', props: { flexDirection: 'column' }, children: props.children ?? [] }
}
export function h(type, props, ...rest) {
  const children = []
  flatten(rest, children)
  if (typeof type === 'function') return type({ ...(props ?? {}), children })
  const { onPress, onSubmit, onInput, onSelect, ...plain } = props ?? {}
  if (type === 'Button') return { type, props: plain, press: { plugin: '', handle: ++counter }, onPress }
  if (type === 'Input') {
    return { type, props: plain, press: { plugin: '', handle: ++counter }, onEvent: e => (e.kind === 'submit' ? onSubmit?.(e.value, e) : onInput?.(e.value, e)) }
  }
  if (type === 'Select') return { type, props: plain, press: { plugin: '', handle: ++counter }, onEvent: e => onSelect?.(e.value, e) }
  return { type, ...(Object.keys(plain).length > 0 && { props: plain }), ...(children.length > 0 && { children }) }
}

export const install = (host, limits) => {
  const instances = new Map()
  let pending = null
  const elements = {}
  for (const name of ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown']) {
    elements[name] = props => {
      const { children, ...rest } = props ?? {}
      return h(name, rest, ...(children === undefined ? [] : Array.isArray(children) ? children : [children]))
    }
  }
  Object.defineProperty(globalThis, '__surface__', {
    value: { run: () => { const s = pending; pending = null; return s === null ? undefined : s() } },
    configurable: true,
  })
  const instanceOf = id => instances.get(id) ?? (() => { throw new Error('no client instance ' + id) })()

  const exportTree = (instance, tree) => {
    let nodes = 0
    const walk = (node, depth) => {
      if (typeof node === 'string') return node
      if (typeof node !== 'object' || node === null) throw new Error('a child that is neither a string nor an element')
      if (++nodes > limits.nodes) throw new Error('a tree of more than ' + limits.nodes + ' nodes')
      if (depth > limits.depth) throw new Error('a tree deeper than ' + limits.depth)
      if (node.type === 'Client') throw new Error('a Client inside the tree')
      const out = { type: node.type }
      if (node.props !== undefined) out.props = JSON.parse(JSON.stringify(node.props))
      const closure = node.type === 'Button' ? node.onPress : node.type === 'Input' || node.type === 'Select' ? node.onEvent : undefined
      if (node.type === 'Button' || node.type === 'Input' || node.type === 'Select') {
        const handle = ++instance.heldCounter
        instance.held.set(handle, closure)
        out.held = handle
        return out
      }
      if (node.children !== undefined) out.children = node.children.map(c => walk(c, depth + 1))
      return out
    }
    const text = JSON.stringify(walk(tree, 0))
    if (text.length > limits.chars) throw new Error('a tree serializing to more than ' + limits.chars + ' characters')
    return text
  }

  const act = (id, instance, kind, payload) => {
    switch (kind) {
      case 'render': instance.scheduled = false; return exportTree(instance, instance.fn(instance.props, instance.surface))
      case 'pointer': instance.pointer?.(payload); return undefined
      case 'key': instance.key?.(payload); return undefined
      case 'tick': instance.timers.get(payload)?.(); return undefined
      case 'held': instance.held.get(payload.handle)?.(payload.event); return undefined
      default: throw new Error('unknown surface call ' + kind)
    }
  }

  return Object.freeze({
    mount: (id, fn, props) => {
      const instance = { fn, props, state: undefined, columns: 0, rows: 0, scheduled: false, pointer: null, key: null, timers: new Map(), held: new Map(), heldCounter: 0 }
      instance.surface = Object.freeze({
        elements,
        get state() { return instance.state },
        get columns() { return instance.columns },
        get rows() { return instance.rows },
        setState: next => { instance.state = next; if (!instance.scheduled) { instance.scheduled = true; host.schedule(id) } },
        every: (ms, fn2) => { const t = host.startTimer(id, ms); instance.timers.set(t, fn2); return () => { if (instance.timers.delete(t)) host.stopTimer(id, t) } },
        onPointer: fn2 => { instance.pointer = fn2; return () => { if (instance.pointer === fn2) instance.pointer = null } },
        onKey: fn2 => { instance.key = fn2; return () => { if (instance.key === fn2) instance.key = null } },
        post: data => host.post(id, JSON.stringify(data)),
      })
      instances.set(id, instance)
    },
    setProps: (id, props) => { instanceOf(id).props = props },
    resize: (id, columns, rows) => { const i = instanceOf(id); i.columns = columns; i.rows = rows },
    stage: (id, kind, payload) => { const instance = instanceOf(id); pending = () => act(id, instance, kind, payload) },
    dropHeld: (id, handles) => { const i = instances.get(id); if (i) for (const hd of handles) i.held.delete(hd) },
    hasListener: (id, kind) => { const i = instances.get(id); return !!i && (kind === 'pointer' ? i.pointer : i.key) !== null },
    unmount: id => { const i = instances.get(id); if (!i) return; instances.delete(id); i.timers.clear(); i.held.clear(); i.pointer = null; i.key = null },
  })
}
