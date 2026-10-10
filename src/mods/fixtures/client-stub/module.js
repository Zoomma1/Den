// Surface module factice : des lignes cliquables, une touche, un bouton et un timer.
export default function Rows(props, surface) {
  const { Box, Text, Button } = surface.elements
  const state = surface.state ?? { hover: -1, ticks: 0, wired: false }
  if (!state.wired) {
    state.wired = true
    surface.setState(state)
    surface.onPointer(e => {
      const row = props.rows[e.y]
      if (e.type === 'down' && row) surface.post({ press: row.id })
      else if (e.type === 'move') surface.setState({ ...surface.state, hover: e.y })
    })
    surface.onKey(e => surface.post({ key: e.key }))
    surface.every(50, () => surface.setState({ ...surface.state, ticks: surface.state.ticks + 1 }))
  }
  return h(Box, { flexDirection: 'column' },
    ...props.rows.map((r, i) => h(Text, { key: r.id, color: state.hover === i ? 'cyan' : undefined }, r.label)),
    h(Text, { dimColor: true }, 'ticks:' + state.ticks),
    h(Button, { key: 'more', label: 'plus', onPress: () => surface.post({ more: true }) }),
  )
}
