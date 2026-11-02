// SPDX-License-Identifier: MPL-2.0
// Converts Chromium's .icon files (the commands in ui/gfx/vector_icon_types.h)
// to SVG, painted the way ui/gfx/paint_vector_icon.cc paints them: even-odd
// fill unless FILL_RULE_NONZERO, round stroke caps, one path per NEW_PATH, and
// paths without PATH_COLOR_ARGB in the caller's color (context-fill).

/**
 * Parses an .icon file into commands. Of several representations (one per
 * CANVAS_DIMENSIONS) only the first is kept; the icons FireDog uses have one.
 *
 * @param {string} source the .icon file
 * @returns {{size: number, commands: Array<{op: string, args: number[]}>}} canvas size and commands
 */
export const parseIcon = (source) => {
  const tokens = source
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
  const commands = []
  for (const token of tokens) {
    if (/^[A-Z_]+$/.test(token)) {
      if (token === 'CANVAS_DIMENSIONS' && commands.some((command) => command.op === 'CANVAS_DIMENSIONS')) break
      commands.push({op: token, args: []})
    } else {
      commands.at(-1).args.push(Number.parseFloat(token.replace(/f$/, '')))
    }
  }
  const dimensions = commands.find((command) => command.op === 'CANVAS_DIMENSIONS')
  return {size: dimensions ? dimensions.args[0] : 32, commands}
}

const format = (value) => Number(value.toFixed(4)).toString()

/**
 * Writes parsed commands as an SVG document.
 *
 * @param {{size: number, commands: Array<{op: string, args: number[]}>}} icon parseIcon's result
 * @returns {string} an SVG whose viewBox is the icon's canvas
 */
export const iconToSvg = ({size, commands}) => {
  const paths = []
  let current = null
  let previous = null
  // H_LINE_TO and the shorthand curves need the current point; track it as SVG does
  let point = [0, 0]
  let start = [0, 0]
  let lastControl = null
  let clip = null
  let flipsInRtl = false
  const newPath = () => {
    current = {d: [], rule: 'evenodd', color: null, alpha: null, stroke: null, cap: 'round', clear: false, aa: true}
    paths.push(current)
  }
  const isCurve = (op) => /CUBIC|QUADRATIC/.test(op ?? '')
  for (const {op, args: a} of commands) {
    if (!current || op === 'NEW_PATH') newPath()
    const d = current.d
    switch (op) {
      case 'NEW_PATH':
      case 'CANVAS_DIMENSIONS':
        break
      case 'FILL_RULE_NONZERO':
        current.rule = 'nonzero'
        break
      case 'PATH_COLOR_ALPHA':
        current.alpha = Math.floor(a[0]) / 255
        break
      case 'PATH_COLOR_ARGB':
        current.color = `rgba(${Math.floor(a[1])},${Math.floor(a[2])},${Math.floor(a[3])},${format(Math.floor(a[0]) / 255)})`
        break
      case 'PATH_MODE_CLEAR':
        current.clear = true
        break
      case 'STROKE':
        current.stroke = a[0]
        break
      case 'CAP_SQUARE':
        current.cap = 'square'
        break
      case 'MOVE_TO':
        d.push(`M${format(a[0])} ${format(a[1])}`)
        point = [a[0], a[1]]
        start = point
        break
      case 'R_MOVE_TO':
        d.push(`m${format(a[0])} ${format(a[1])}`)
        point = [point[0] + a[0], point[1] + a[1]]
        start = point
        break
      case 'ARC_TO':
      case 'R_ARC_TO': {
        const relative = op === 'R_ARC_TO'
        d.push(`${relative ? 'a' : 'A'}${a.slice(0, 5).map(format).join(' ')} ${format(a[5])} ${format(a[6])}`)
        point = relative ? [point[0] + a[5], point[1] + a[6]] : [a[5], a[6]]
        break
      }
      case 'LINE_TO':
        d.push(`L${format(a[0])} ${format(a[1])}`)
        point = [a[0], a[1]]
        break
      case 'R_LINE_TO':
        d.push(`l${format(a[0])} ${format(a[1])}`)
        point = [point[0] + a[0], point[1] + a[1]]
        break
      case 'H_LINE_TO':
        d.push(`H${format(a[0])}`)
        point = [a[0], point[1]]
        break
      case 'R_H_LINE_TO':
        d.push(`h${format(a[0])}`)
        point = [point[0] + a[0], point[1]]
        break
      case 'V_LINE_TO':
        d.push(`V${format(a[0])}`)
        point = [point[0], a[0]]
        break
      case 'R_V_LINE_TO':
        d.push(`v${format(a[0])}`)
        point = [point[0], point[1] + a[0]]
        break
      case 'CUBIC_TO':
        d.push(`C${a.map(format).join(' ')}`)
        lastControl = [a[2], a[3]]
        point = [a[4], a[5]]
        break
      case 'R_CUBIC_TO':
        d.push(`c${a.map(format).join(' ')}`)
        lastControl = [point[0] + a[2], point[1] + a[3]]
        point = [point[0] + a[4], point[1] + a[5]]
        break
      case 'CUBIC_TO_SHORTHAND':
      case 'QUADRATIC_TO_SHORTHAND':
      case 'R_QUADRATIC_TO_SHORTHAND': {
        // As paint_vector_icon.cc does, reflect the control point only after a curve
        const delta = isCurve(previous) && lastControl ? [point[0] - lastControl[0], point[1] - lastControl[1]] : [0, 0]
        const control = [point[0] + delta[0], point[1] + delta[1]]
        if (op === 'CUBIC_TO_SHORTHAND') {
          d.push(`C${format(control[0])} ${format(control[1])} ${a.map(format).join(' ')}`)
          lastControl = [a[0], a[1]]
          point = [a[2], a[3]]
        } else if (op === 'QUADRATIC_TO_SHORTHAND') {
          d.push(`Q${format(control[0])} ${format(control[1])} ${a.map(format).join(' ')}`)
          lastControl = control
          point = [a[0], a[1]]
        } else {
          // Upstream passes an absolute control point to Skia's rQuadTo; keep that
          d.push(`q${format(control[0])} ${format(control[1])} ${a.map(format).join(' ')}`)
          lastControl = [point[0] + control[0], point[1] + control[1]]
          point = [point[0] + a[0], point[1] + a[1]]
        }
        break
      }
      case 'QUADRATIC_TO':
        d.push(`Q${a.map(format).join(' ')}`)
        lastControl = [a[0], a[1]]
        point = [a[2], a[3]]
        break
      case 'R_QUADRATIC_TO':
        d.push(`q${a.map(format).join(' ')}`)
        lastControl = [point[0] + a[0], point[1] + a[1]]
        point = [point[0] + a[2], point[1] + a[3]]
        break
      case 'OVAL':
      case 'CIRCLE': {
        const [cx, cy, rx, ry = rx] = a
        d.push(`M${format(cx - rx)} ${format(cy)}a${format(rx)} ${format(ry)} 0 1 0 ${format(rx * 2)} 0a${format(rx)} ${format(ry)} 0 1 0 ${format(-rx * 2)} 0Z`)
        break
      }
      case 'ROUND_RECT': {
        const [x, y, w, h, r] = a
        d.push(
          `M${format(x + r)} ${format(y)}h${format(w - 2 * r)}a${format(r)} ${format(r)} 0 0 1 ${format(r)} ${format(r)}` +
            `v${format(h - 2 * r)}a${format(r)} ${format(r)} 0 0 1 ${format(-r)} ${format(r)}h${format(-(w - 2 * r))}` +
            `a${format(r)} ${format(r)} 0 0 1 ${format(-r)} ${format(-r)}v${format(-(h - 2 * r))}a${format(r)} ${format(r)} 0 0 1 ${format(r)} ${format(-r)}Z`,
        )
        break
      }
      case 'CLOSE':
        d.push('Z')
        point = start
        break
      case 'CLIP':
        clip = a
        break
      case 'DISABLE_AA':
        current.aa = false
        break
      case 'FLIPS_IN_RTL':
        flipsInRtl = true
        break
      default:
        throw new Error(`unknown icon command ${op}`)
    }
    if (!isCurve(op)) lastControl = null
    previous = op
  }
  const body = paths
    .filter((path) => path.d.length > 0)
    .map((path) => {
      const color = path.color ?? 'context-fill'
      const paint = path.stroke !== null
        ? `fill="none" stroke="${color}" stroke-width="${format(path.stroke)}" stroke-linecap="${path.cap}"`
        : `fill="${color}" fill-rule="${path.rule}"`
      const opacity = path.alpha !== null ? ` ${path.stroke !== null ? 'stroke' : 'fill'}-opacity="${format(path.alpha)}"` : ''
      const aa = path.aa ? '' : ' shape-rendering="crispEdges"'
      return `<path d="${path.d.join('')}" ${paint}${opacity}${aa}/>`
    })
    .join('')
  const clipped = clip
    ? `<clipPath id="c"><rect x="${clip[0]}" y="${clip[1]}" width="${clip[2]}" height="${clip[3]}"/></clipPath><g clip-path="url(#c)">${body}</g>`
    : body
  const mirror = flipsInRtl ? ' data-flips-in-rtl="true"' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"${mirror}>${clipped}</svg>\n`
}
