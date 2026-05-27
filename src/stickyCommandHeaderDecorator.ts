import { Injectable } from '@angular/core'

import { SessionMiddleware, TerminalDecorator } from 'tabby-terminal'

type ControlSequenceState =
  | 'normal'
  | 'escape'
  | 'csi'
  | 'osc'
  | 'oscEscape'
  | 'string'
  | 'stringEscape'

interface FilteredTerminalText {
  text: string
  state: ControlSequenceState
}

interface CommandBlock {
  command: string
  output: string
  active: boolean
  truncated: boolean
  startMarker?: XtermMarker
}

interface HeredocState {
  delimiter: string
  allowLeadingTabs: boolean
}

interface XtermMarker {
  line: number
  isDisposed?: boolean
  dispose?: () => void
}

interface XtermBuffer {
  type?: string
  baseY?: number
  viewportY?: number
  length?: number
}

interface XtermLike {
  buffer?: {
    active?: XtermBuffer
  }
  rows?: number
  onResize?: (listener: (size: { cols: number, rows: number }) => void) => { dispose?: () => void }
  onScroll?: (listener: (viewportY: number) => void) => { dispose?: () => void }
  registerMarker?: (cursorYOffset?: number) => XtermMarker | undefined
}

type CommandBlockResolution =
  | { kind: 'block', block: CommandBlock }
  | { kind: 'fallback', block: CommandBlock }
  | { kind: 'uncertain' }

const MAX_COMMAND_BLOCKS = 20
const MAX_OUTPUT_CHARS_PER_BLOCK = 256 * 1024
const COPY_STATUS_TIMEOUT_MS = 1800
const DEBUG_STICKY_COMMAND_RESOLVER = false
const DEBUG_STICKY_COMMAND_RESOLVER_PREFIX = '[TSC resolver]'
const STICKY_COMMAND_HEADER_CLASS = 'tabby-sticky-command-header'
const STICKY_COMMAND_HEADER_OWNER_ATTRIBUTE = 'data-tabby-sticky-command-header-owner'
const STICKY_COMMAND_HEADER_LABEL_ATTRIBUTE = 'data-tabby-sticky-command-header-label'
const BRAILLE_SPINNER_FRAMES = new Set([
  '⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷',
  '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋',
])
const ASCII_SPINNER_FRAMES = new Set(['|', '/', '-', '\\'])
const SIMPLE_HEREDOC_OPERATOR = /(?:^|[\s;&|])<<(-?)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_./-]+))(?=\s|$)/
const MIN_CLEAR_COMMAND_PREFIX_CHARS = 24
const BOUNDARY_TRAILING_WINDOW_LINES = 24
const BOUNDARY_TRAILING_WINDOW_CHARS = 4096

const getSimpleHeredocState = (command: string): HeredocState | null => {
  const match = command.match(SIMPLE_HEREDOC_OPERATOR)

  if (!match) {
    return null
  }

  return {
    delimiter: match[2] || match[3] || match[4],
    allowLeadingTabs: match[1] === '-',
  }
}

const isHeredocTerminator = (line: string, heredoc: HeredocState): boolean => {
  if (!heredoc.allowLeadingTabs) {
    return line === heredoc.delimiter
  }

  return line.replace(/^\t+/, '') === heredoc.delimiter
}

const normaliseCarriageReturnsForCopy = (output: string): string => {
  const lines: string[] = []
  let currentLine: string[] = []
  let cursor = 0
  const chars = Array.from(output)

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]

    if (char === '\r') {
      if (chars[index + 1] === '\n') {
        lines.push(currentLine.join(''))
        currentLine = []
        cursor = 0
        index++
        continue
      }

      cursor = 0
      continue
    }

    if (char === '\n') {
      lines.push(currentLine.join(''))
      currentLine = []
      cursor = 0
      continue
    }

    currentLine[cursor] = char
    cursor++
  }

  lines.push(currentLine.join(''))

  return lines.join('\n')
}

const isBrailleSpinnerOnlyLine = (line: string): boolean => {
  const trimmedLine = line.trim()

  return Boolean(trimmedLine) && Array.from(trimmedLine).every(char => BRAILLE_SPINNER_FRAMES.has(char))
}

const stripBrailleSpinnerRuns = (line: string): string => {
  const chars = Array.from(line)
  let start = 0
  let end = chars.length

  while (start < end && BRAILLE_SPINNER_FRAMES.has(chars[start])) {
    start++
  }

  while (end > start && BRAILLE_SPINNER_FRAMES.has(chars[end - 1])) {
    end--
  }

  return chars.slice(start, end).join('')
}

const getAsciiSpinnerOnlyFrame = (line: string): string | null => {
  const trimmedLine = line.trim()

  return ASCII_SPINNER_FRAMES.has(trimmedLine) ? trimmedLine : null
}

const findAsciiSpinnerNoiseLines = (lines: string[]): Set<number> => {
  const noiseLines = new Set<number>()
  let runStart: number | null = null
  let runFrames = new Set<string>()

  const markRun = (runEnd: number): void => {
    if (runStart === null) {
      return
    }

    if (runEnd - runStart >= 3 || runFrames.size >= 2) {
      for (let index = runStart; index < runEnd; index++) {
        noiseLines.add(index)
      }
    }

    runStart = null
    runFrames = new Set<string>()
  }

  for (let index = 0; index < lines.length; index++) {
    const frame = getAsciiSpinnerOnlyFrame(lines[index])

    if (!frame) {
      markRun(index)
      continue
    }

    if (runStart === null) {
      runStart = index
    }

    runFrames.add(frame)
  }

  markRun(lines.length)

  return noiseLines
}

const formatOutputForCopy = (output: string): string => {
  const lines = normaliseCarriageReturnsForCopy(output).split('\n')
  const asciiSpinnerNoiseLines = findAsciiSpinnerNoiseLines(lines)

  return lines
    .map(line => ({
      originalLine: line,
      cleanedLine: stripBrailleSpinnerRuns(line),
    }))
    .filter((line, index) => !isBrailleSpinnerOnlyLine(line.originalLine) && !asciiSpinnerNoiseLines.has(index))
    .map(line => line.cleanedLine)
    .join('\n')
}

const getSubmittedInputVariants = (submittedLine: string, command: string): string[] => {
  return Array.from(new Set([submittedLine.trimEnd(), command].filter(Boolean)))
}

const isLikelyPromptPrefix = (prefix: string): boolean => {
  const trimmedPrefix = prefix.trimEnd()

  return trimmedPrefix.length > 0 && trimmedPrefix.length <= 160 && /[$#>%\]]$/.test(trimmedPrefix)
}

const isTrailingEchoedInputLine = (line: string, submittedInputVariants: string[]): boolean => {
  const normalisedLine = normaliseCarriageReturnsForCopy(line).split('\n').pop() ?? ''
  const trimmedLine = normalisedLine.trimEnd()

  return submittedInputVariants.some(submittedInput => {
    if (trimmedLine === submittedInput) {
      return true
    }

    if (!trimmedLine.endsWith(submittedInput)) {
      return false
    }

    return isLikelyPromptPrefix(trimmedLine.slice(0, -submittedInput.length))
  })
}

const trimTrailingEchoedInputFromOutput = (output: string, submittedLine: string, command: string): string => {
  const submittedInputVariants = getSubmittedInputVariants(submittedLine, command)

  if (!output || !submittedInputVariants.length) {
    return output
  }

  const lineStart = Math.max(output.lastIndexOf('\n'), output.lastIndexOf('\r')) + 1
  const trailingLine = output.slice(lineStart)

  if (!trailingLine || !isTrailingEchoedInputLine(trailingLine, submittedInputVariants)) {
    return output
  }

  return output.slice(0, lineStart)
}

interface BoundaryNormalisedText {
  text: string
  rawIndexes: number[]
}

interface BoundaryCommandMarker {
  text: string
  commandText: string
}

const normaliseTextForBoundaryMatch = (text: string): BoundaryNormalisedText => {
  const chars: string[] = []
  const rawIndexes: number[] = []

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (char === '\u0008' || char === '\u007f') {
      chars.pop()
      rawIndexes.pop()
      continue
    }

    if (char < ' ' && char !== '\t') {
      continue
    }

    chars.push(char)
    rawIndexes.push(index)
  }

  return {
    text: chars.join(''),
    rawIndexes,
  }
}

const addBoundaryCommandMarkers = (
  markers: BoundaryCommandMarker[],
  seenMarkers: Set<string>,
  commandText: string,
): void => {
  const trimmedCommandText = commandText.trimEnd()

  if (!trimmedCommandText || seenMarkers.has(trimmedCommandText)) {
    return
  }

  seenMarkers.add(trimmedCommandText)
  markers.push({
    text: trimmedCommandText,
    commandText: trimmedCommandText,
  })

  const minPrefixLength = Math.min(
    trimmedCommandText.length,
    Math.max(MIN_CLEAR_COMMAND_PREFIX_CHARS, Math.ceil(trimmedCommandText.length * 0.35)),
  )

  if (trimmedCommandText.length > minPrefixLength) {
    const prefix = trimmedCommandText.slice(0, minPrefixLength)

    if (!seenMarkers.has(prefix)) {
      seenMarkers.add(prefix)
      markers.push({
        text: prefix,
        commandText: trimmedCommandText,
      })
    }
  }
}

const getBoundaryCommandMarkers = (command: string): BoundaryCommandMarker[] => {
  const normalisedCommand = normaliseTextForBoundaryMatch(command).text.trim()
  const markers: BoundaryCommandMarker[] = []
  const seenMarkers = new Set<string>()

  addBoundaryCommandMarkers(markers, seenMarkers, normalisedCommand)

  for (let offset = 1; offset <= 3 && offset < normalisedCommand.length; offset++) {
    if (/[\sA-Za-z0-9]/.test(normalisedCommand[offset - 1])) {
      break
    }

    addBoundaryCommandMarkers(markers, seenMarkers, normalisedCommand.slice(offset))
  }

  const quotedTestMarkerMatch = normalisedCommand.match(/"==\s*TSC\s+TEST\s+BLOCK\s+[^:=;\r\n]+/i)

  if (quotedTestMarkerMatch) {
    addBoundaryCommandMarkers(markers, seenMarkers, quotedTestMarkerMatch[0])
  }

  const unquotedTestMarkerMatch = normalisedCommand.match(/==\s*TSC\s+TEST\s+BLOCK\s+[^:=;\r\n]+/i)

  if (unquotedTestMarkerMatch) {
    addBoundaryCommandMarkers(markers, seenMarkers, unquotedTestMarkerMatch[0])
  }

  return markers
}

const getBoundaryPrefixTrimStart = (normalisedWindow: BoundaryNormalisedText, markerIndex: number): number => {
  if (markerIndex === 0) {
    return 0
  }

  const boundaryPrefix = normalisedWindow.text.slice(0, markerIndex)
  const powershellPromptIndex = boundaryPrefix.lastIndexOf('PS ')

  if (powershellPromptIndex !== -1) {
    return normalisedWindow.rawIndexes[powershellPromptIndex] ?? 0
  }

  return normalisedWindow.rawIndexes[markerIndex] ?? 0
}

const getRetainedOutputTrailingWindowStart = (output: string): number => {
  const charWindowStart = Math.max(0, output.length - BOUNDARY_TRAILING_WINDOW_CHARS)
  let lineWindowStart = 0
  let lineBreaks = 0

  for (let index = output.length - 1; index >= 0; index--) {
    if (output[index] !== '\n' && output[index] !== '\r') {
      continue
    }

    if (output[index] === '\n' && output[index - 1] === '\r') {
      index--
    }

    lineBreaks++

    if (lineBreaks >= BOUNDARY_TRAILING_WINDOW_LINES) {
      lineWindowStart = index + 1
      break
    }
  }

  return Math.max(charWindowStart, lineWindowStart)
}

const getRetainedOutputBoundaryTrimStart = (trailingWindow: string, nextCommand: string): number | null => {
  const normalisedWindow = normaliseTextForBoundaryMatch(trailingWindow)
  const markers = getBoundaryCommandMarkers(nextCommand)
  let earliestTrimStart: number | null = null

  if (!normalisedWindow.text || !markers.length) {
    return null
  }

  for (const marker of markers) {
    let searchFrom = 0

    while (searchFrom < normalisedWindow.text.length) {
      const markerIndex = normalisedWindow.text.indexOf(marker.text, searchFrom)

      if (markerIndex === -1) {
        break
      }

      const trimStart = getBoundaryPrefixTrimStart(normalisedWindow, markerIndex)

      if (earliestTrimStart === null || trimStart < earliestTrimStart) {
        earliestTrimStart = trimStart
      }

      searchFrom = markerIndex + 1
    }
  }

  return earliestTrimStart
}

const trimRetainedOutputAtNextCommandBoundary = (output: string, nextCommand: string | null): string => {
  if (!output || !nextCommand) {
    return output
  }

  const windowStart = getRetainedOutputTrailingWindowStart(output)
  const trailingWindow = output.slice(windowStart)
  const trimStart = getRetainedOutputBoundaryTrimStart(trailingWindow, nextCommand)

  if (trimStart === null) {
    return output
  }

  return output.slice(0, windowStart + trimStart)
}

class StickyCommandHeaderCapture extends SessionMiddleware {
  constructor (
    private readonly onInput: (data: Buffer) => void,
    private readonly onOutput: (data: Buffer) => void,
  ) {
    super()
  }

  feedFromSession (data: Buffer): void {
    this.onOutput(data)
    super.feedFromSession(data)
  }

  feedFromTerminal (data: Buffer): void {
    this.onInput(data)
    super.feedFromTerminal(data)
  }
}

@Injectable()
export class StickyCommandHeaderDecorator extends TerminalDecorator {
  private cleanup = new WeakMap<any, () => void>()

  attach (terminal: any): void {
    this.cleanup.get(terminal)?.()
    this.cleanup.delete(terminal)

    const host = terminal.element?.nativeElement as HTMLElement | undefined

    if (!host) {
      return
    }

    host.style.position = host.style.position || 'relative'

    host.querySelectorAll(`.${STICKY_COMMAND_HEADER_CLASS}`).forEach(existingHeader => existingHeader.remove())

    const header = document.createElement('div')
    const headerOwnerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

    header.className = STICKY_COMMAND_HEADER_CLASS
    header.setAttribute(STICKY_COMMAND_HEADER_OWNER_ATTRIBUTE, headerOwnerId)
    header.style.display = 'none'
    header.style.position = 'absolute'
    header.style.top = '4px'
    header.style.left = '6px'
    header.style.maxWidth = 'calc(100% - 12px)'
    header.style.zIndex = '20'
    header.style.padding = '2px 6px'
    header.style.fontFamily = 'var(--font-family, monospace)'
    header.style.fontSize = '12px'
    header.style.lineHeight = '16px'
    header.style.whiteSpace = 'nowrap'
    header.style.overflow = 'hidden'
    header.style.textOverflow = 'ellipsis'
    header.style.background = 'rgba(0, 0, 0, 0.74)'
    header.style.color = '#fff'
    header.style.pointerEvents = 'none'
    header.style.alignItems = 'center'
    header.style.gap = '6px'
    header.style.borderRadius = '4px'
    header.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.32)'

    const commandLabel = document.createElement('span')

    commandLabel.setAttribute(STICKY_COMMAND_HEADER_LABEL_ATTRIBUTE, 'command')
    commandLabel.style.flex = '1 1 auto'
    commandLabel.style.minWidth = '0'
    commandLabel.style.overflow = 'hidden'
    commandLabel.style.textOverflow = 'ellipsis'
    commandLabel.style.pointerEvents = 'none'

    const copyButton = document.createElement('button')

    copyButton.type = 'button'
    copyButton.textContent = 'Copy'
    copyButton.title = 'Copy output'
    copyButton.setAttribute('aria-label', 'Copy output')
    copyButton.style.flex = '0 0 auto'
    copyButton.style.border = '1px solid rgba(255, 255, 255, 0.22)'
    copyButton.style.borderRadius = '4px'
    copyButton.style.padding = '0 5px'
    copyButton.style.font = 'inherit'
    copyButton.style.fontSize = '11px'
    copyButton.style.lineHeight = '15px'
    copyButton.style.background = 'rgba(255, 255, 255, 0.08)'
    copyButton.style.color = 'rgba(255, 255, 255, 0.78)'
    copyButton.style.cursor = 'pointer'
    copyButton.style.pointerEvents = 'auto'

    const statusLabel = document.createElement('span')

    statusLabel.style.flex = '0 0 auto'
    statusLabel.style.color = 'rgba(255, 255, 255, 0.72)'
    statusLabel.style.pointerEvents = 'none'

    header.appendChild(commandLabel)
    header.appendChild(copyButton)
    header.appendChild(statusLabel)

    host.appendChild(header)

    let pendingInput = ''
    let lastCommand = ''
    let heredoc: HeredocState | null = null
    let currentBlock: CommandBlock | null = null
    let commandBlocks: CommandBlock[] = []
    let alternateScreenActive = false
    let viewport: HTMLElement | null = null
    let displayedBlock: CommandBlock | null = null
    let inputControlSequenceState: ControlSequenceState = 'normal'
    let outputControlSequenceState: ControlSequenceState = 'normal'
    let statusTimeout: number | null = null
    let capture: StickyCommandHeaderCapture | null = null
    let captureMiddlewareStack: any = null
    let inputSubscription: any = null
    let xtermScrollSubscription: { dispose?: () => void } | null = null
    let xtermResizeSubscription: { dispose?: () => void } | null = null

    const getOwnedHeaders = (): HTMLElement[] => {
      return Array.from(host.querySelectorAll(`.${STICKY_COMMAND_HEADER_CLASS}`)) as HTMLElement[]
    }

    const ensureSingleOwnedHeader = (): HTMLElement[] => {
      if (!header.isConnected) {
        host.appendChild(header)
      }

      const ownedHeaders = getOwnedHeaders()

      for (const ownedHeader of ownedHeaders) {
        if (ownedHeader !== header) {
          ownedHeader.remove()
        }
      }

      return getOwnedHeaders()
    }

    const isHeaderVisible = (): boolean => {
      return header.isConnected && header.style.display !== 'none'
    }

    const getShortCommandLabel = (block: CommandBlock | null | undefined): string | null => {
      if (!block) {
        return null
      }

      const label = block.command.replace(/\s+/g, ' ').trim()

      return label.length > 72 ? `${label.slice(0, 69)}...` : label
    }

    const disposeBlockMarkers = (block: CommandBlock): void => {
      block.startMarker?.dispose?.()
      block.startMarker = undefined
    }

    const clearCommandBlocks = (): void => {
      commandBlocks.forEach(disposeBlockMarkers)
      commandBlocks = []
    }

    const trimCommandBlocks = (): void => {
      if (commandBlocks.length <= MAX_COMMAND_BLOCKS) {
        return
      }

      const removedBlocks = commandBlocks.slice(0, commandBlocks.length - MAX_COMMAND_BLOCKS)

      removedBlocks.forEach(disposeBlockMarkers)
      commandBlocks = commandBlocks.slice(-MAX_COMMAND_BLOCKS)
    }

    const getXterm = (): XtermLike | null => {
      const xterm = terminal.frontend?.xterm

      if (!xterm || typeof xterm !== 'object') {
        return null
      }

      return xterm as XtermLike
    }

    const getNormalXtermBuffer = (): XtermBuffer | null => {
      const buffer = getXterm()?.buffer?.active

      if (!buffer || buffer.type !== 'normal') {
        return null
      }

      return buffer
    }

    const registerBlockStartMarker = (cursorYOffset = 0): XtermMarker | undefined => {
      if (alternateScreenActive || !getNormalXtermBuffer()) {
        return undefined
      }

      const xterm = getXterm()
      const registerMarker = xterm?.registerMarker

      if (typeof registerMarker !== 'function') {
        return undefined
      }

      try {
        return registerMarker.call(xterm, cursorYOffset)
      } catch {
        return undefined
      }
    }

    const getViewportTopLine = (): number | null => {
      if (alternateScreenActive) {
        return null
      }

      const viewportY = getNormalXtermBuffer()?.viewportY

      return typeof viewportY === 'number' && Number.isFinite(viewportY) ? viewportY : null
    }

    const getBufferLength = (): number | null => {
      const length = getNormalXtermBuffer()?.length

      return typeof length === 'number' && Number.isFinite(length) && length >= 0 ? length : null
    }

    const getViewportRows = (): number | null => {
      const rows = getXterm()?.rows

      return typeof rows === 'number' && Number.isFinite(rows) && rows > 0 ? rows : null
    }

    const getMarkerLine = (marker: XtermMarker | undefined): number | null => {
      if (!marker || marker.isDisposed || marker.line < 0) {
        return null
      }

      return Number.isFinite(marker.line) ? marker.line : null
    }

    const getBottomState = (): { result: boolean, rule: string } => {
      if (alternateScreenActive) {
        return { result: false, rule: 'alternate-screen' }
      }

      const buffer = getNormalXtermBuffer()
      const viewportY = buffer?.viewportY
      const baseY = buffer?.baseY

      if (
        typeof viewportY === 'number' &&
        Number.isFinite(viewportY) &&
        typeof baseY === 'number' &&
        Number.isFinite(baseY)
      ) {
        return { result: viewportY >= baseY, rule: 'viewportY>=baseY' }
      }

      const viewportTopLine = getViewportTopLine()
      const bufferLength = getBufferLength()
      const viewportRows = getViewportRows()

      if (viewportTopLine !== null && bufferLength !== null && viewportRows !== null) {
        return { result: viewportTopLine + viewportRows >= bufferLength, rule: 'viewportY+rows>=length' }
      }

      if (!viewport) {
        return { result: false, rule: 'no-dom-viewport' }
      }

      return {
        result: viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4,
        rule: 'dom-scroll',
      }
    }

    const isAtBottom = (): boolean => {
      return getBottomState().result
    }

    const resolveCandidateBufferLine = (
      candidateLine: number,
      markerBackedBlocks: Array<{ block: CommandBlock, startLine: number, blockIndex: number }>,
      bufferLength: number | null,
    ): CommandBlock | null => {
      for (let index = 0; index < markerBackedBlocks.length; index++) {
        const range = markerBackedBlocks[index]
        const nextRange = markerBackedBlocks[index + 1]
        const endLine = nextRange?.startLine ?? (
          range.blockIndex === commandBlocks.length - 1 ? bufferLength : null
        )

        if (endLine === null || endLine <= range.startLine) {
          return null
        }

        const rangeCrossesMarkerlessBlock = nextRange
          ? nextRange.blockIndex > range.blockIndex + 1
          : range.blockIndex !== commandBlocks.length - 1

        if (rangeCrossesMarkerlessBlock && range.startLine <= candidateLine && candidateLine < endLine) {
          return null
        }

        if (range.startLine <= candidateLine && candidateLine < endLine) {
          return range.block
        }
      }

      return null
    }

    const resolveVisibleCommandBlock = (): CommandBlockResolution => {
      if (alternateScreenActive) {
        return { kind: 'uncertain' }
      }

      if (isAtBottom() && currentBlock) {
        return { kind: 'fallback', block: currentBlock }
      }

      const viewportTopLine = getViewportTopLine()

      if (viewportTopLine === null) {
        return { kind: 'uncertain' }
      }

      const viewportRows = getViewportRows()

      if (viewportRows === null) {
        return { kind: 'uncertain' }
      }

      if (!commandBlocks.length) {
        return { kind: 'uncertain' }
      }

      const bufferLength = getBufferLength()
      const markerBackedBlocks: Array<{ block: CommandBlock, startLine: number, blockIndex: number }> = []

      for (let blockIndex = 0; blockIndex < commandBlocks.length; blockIndex++) {
        const block = commandBlocks[blockIndex]
        const startLine = getMarkerLine(block.startMarker)

        if (startLine === null) {
          continue
        }

        const previousStartLine = markerBackedBlocks[markerBackedBlocks.length - 1]?.startLine

        if (previousStartLine !== undefined && startLine <= previousStartLine) {
          return { kind: 'uncertain' }
        }

        markerBackedBlocks.push({ block, startLine, blockIndex })
      }

      if (!markerBackedBlocks.length) {
        return { kind: 'uncertain' }
      }

      const maxProbeOffset = Math.min(viewportRows - 1, 5)
      let resolvedBlock: CommandBlock | null = null

      for (let offset = 0; offset <= maxProbeOffset; offset++) {
        const candidateBlock = resolveCandidateBufferLine(viewportTopLine + offset, markerBackedBlocks, bufferLength)

        if (!candidateBlock) {
          continue
        }

        if (!resolvedBlock) {
          resolvedBlock = candidateBlock
          continue
        }

        if (resolvedBlock !== candidateBlock) {
          return { kind: 'uncertain' }
        }
      }

      return resolvedBlock ? { kind: 'block', block: resolvedBlock } : { kind: 'uncertain' }
    }

    const getResolutionKindLabel = (resolution: CommandBlockResolution): string => {
      if (resolution.kind === 'block') {
        return 'marker'
      }

      if (resolution.kind === 'fallback') {
        return 'bottom'
      }

      return 'uncertain'
    }

    const debugResolver = (
      source: string,
      details: {
        onScrollValue?: number
        resize?: { cols: number, rows: number }
        resolution?: CommandBlockResolution
        headerShown?: boolean
        displayedBlockBeforeUpdate?: CommandBlock | null
        headerTextBeforeUpdate?: string
        headerTextAfterUpdate?: string
        ownedHeaderCount?: number
        headerConnected?: boolean
        headerVisible?: boolean
      } = {},
    ): void => {
      if (!DEBUG_STICKY_COMMAND_RESOLVER) {
        return
      }

      const xterm = getXterm()
      const buffer = xterm?.buffer?.active
      const viewportY = buffer?.viewportY
      const rows = xterm?.rows
      const bottomState = getBottomState()
      const resolution = details.resolution ?? resolveVisibleCommandBlock()
      const resolvedBlock = resolution.kind === 'uncertain' ? null : resolution.block
      const viewportBottom = (
        typeof viewportY === 'number' &&
        Number.isFinite(viewportY) &&
        typeof rows === 'number' &&
        Number.isFinite(rows)
      ) ? viewportY + rows - 1 : null

      console.log(DEBUG_STICKY_COMMAND_RESOLVER_PREFIX, {
        source,
        onScrollValue: details.onScrollValue,
        resize: details.resize,
        activeBufferType: buffer?.type ?? null,
        viewportY: typeof viewportY === 'number' ? viewportY : null,
        baseY: typeof buffer?.baseY === 'number' ? buffer.baseY : null,
        length: typeof buffer?.length === 'number' ? buffer.length : null,
        rows: typeof rows === 'number' ? rows : null,
        viewportBottom,
        isAtBottom: bottomState.result,
        isAtBottomRule: bottomState.rule,
        currentBlock: getShortCommandLabel(currentBlock),
        displayedBlockBeforeUpdate: getShortCommandLabel(
          details.displayedBlockBeforeUpdate === undefined ? displayedBlock : details.displayedBlockBeforeUpdate,
        ),
        resolvedBlock: getShortCommandLabel(resolvedBlock),
        resolvedKind: getResolutionKindLabel(resolution),
        copyableBlock: getShortCommandLabel(getCopyableBlock()),
        commandBlocks: commandBlocks.map((block, index) => ({
          index,
          label: getShortCommandLabel(block),
          markerLine: typeof block.startMarker?.line === 'number' ? block.startMarker.line : null,
          markerDisposed: block.startMarker?.line === -1 || block.startMarker?.isDisposed === true,
          isDisposed: block.startMarker?.isDisposed ?? null,
          storedStartLine: (block as any).startLine ?? null,
          storedEndLine: (block as any).endLine ?? null,
          storedOutputCount: (block as any).outputCount ?? null,
          outputChars: block.output.length,
          outputLines: block.output ? normaliseCarriageReturnsForCopy(block.output).split('\n').length : 0,
          active: block.active,
          truncated: block.truncated,
        })),
        headerShown: details.headerShown ?? header.style.display !== 'none',
        headerOwnerId,
        ownedHeaderCount: details.ownedHeaderCount ?? getOwnedHeaders().length,
        headerTextBeforeUpdate: details.headerTextBeforeUpdate,
        headerTextAfterUpdate: details.headerTextAfterUpdate ?? commandLabel.textContent,
        headerConnected: details.headerConnected ?? header.isConnected,
        headerVisible: details.headerVisible ?? isHeaderVisible(),
      })
    }

    const getCopyableBlock = (): CommandBlock | null => {
      const block = displayedBlock

      if (!block || !block.output.trim()) {
        return null
      }

      return block
    }

    const getNextCommandForBlock = (block: CommandBlock): string | null => {
      const blockIndex = commandBlocks.indexOf(block)

      if (blockIndex === -1) {
        return null
      }

      return commandBlocks[blockIndex + 1]?.command ?? null
    }

    const updateHeader = (source = 'manual update', details: { onScrollValue?: number, resize?: { cols: number, rows: number } } = {}): void => {
      const resolution = resolveVisibleCommandBlock()
      const block = resolution.kind === 'uncertain' ? null : resolution.block
      const displayedBlockBeforeUpdate = displayedBlock
      const headerTextBeforeUpdate = commandLabel.textContent
      const ownedHeaders = ensureSingleOwnedHeader()

      displayedBlock = block

      if (!block || alternateScreenActive) {
        commandLabel.textContent = ''
        header.style.display = 'none'
        copyButton.style.display = 'none'
        debugResolver(source, {
          ...details,
          resolution,
          headerShown: false,
          displayedBlockBeforeUpdate,
          headerTextBeforeUpdate,
          headerTextAfterUpdate: commandLabel.textContent,
          ownedHeaderCount: ownedHeaders.length,
          headerConnected: header.isConnected,
          headerVisible: isHeaderVisible(),
        })
        return
      }

      commandLabel.textContent = block.command
      commandLabel.title = block.command
      copyButton.style.display = block.output.trim() ? 'inline-block' : 'none'
      header.style.display = 'flex'
      debugResolver(source, {
        ...details,
        resolution,
        headerShown: true,
        displayedBlockBeforeUpdate,
        headerTextBeforeUpdate,
        headerTextAfterUpdate: commandLabel.textContent,
        ownedHeaderCount: ownedHeaders.length,
        headerConnected: header.isConnected,
        headerVisible: isHeaderVisible(),
      })
    }

    const setStatus = (message: string): void => {
      statusLabel.textContent = message

      if (statusTimeout !== null) {
        window.clearTimeout(statusTimeout)
      }

      statusTimeout = window.setTimeout(() => {
        statusLabel.textContent = ''
        statusTimeout = null
      }, COPY_STATUS_TIMEOUT_MS)
    }

    const handleDomScroll = (): void => {
      updateHeader('DOM scroll')
    }

    const findViewport = (): void => {
      if (viewport) {
        viewport.removeEventListener('scroll', handleDomScroll)
      }

      viewport = host.querySelector('.xterm-viewport') as HTMLElement | null

      if (viewport) {
        viewport.addEventListener('scroll', handleDomScroll)
      }

      updateHeader('attach')
    }

    const attachXtermEventDiagnostics = (): void => {
      const xterm = getXterm()

      if (!xterm) {
        debugResolver('attach')
        return
      }

      if (!xtermScrollSubscription && typeof xterm.onScroll === 'function') {
        xtermScrollSubscription = xterm.onScroll((viewportY: number) => {
          updateHeader('xterm onScroll', { onScrollValue: viewportY })
        })
      }

      if (!xtermResizeSubscription && typeof xterm.onResize === 'function') {
        xtermResizeSubscription = xterm.onResize((size: { cols: number, rows: number }) => {
          updateHeader('resize', { resize: size })
        })
      }

      updateHeader('attach')
    }

    const filterTerminalText = (text: string, initialState: ControlSequenceState): FilteredTerminalText => {
      let filtered = ''
      let state = initialState

      for (const char of text) {
        const code = char.charCodeAt(0)

        if (state === 'normal') {
          if (char === '\u001b') {
            state = 'escape'
            continue
          }

          if (char === '\u009b') {
            state = 'csi'
            continue
          }

          if (char === '\u009d') {
            state = 'osc'
            continue
          }

          if (char === '\u0090' || char === '\u009e' || char === '\u009f') {
            state = 'string'
            continue
          }

          if (
            (code < 32 || code === 127) &&
            char !== '\r' &&
            char !== '\n' &&
            char !== '\u0008' &&
            char !== '\t' &&
            char !== '\u007f'
          ) {
            continue
          }

          filtered += char
          continue
        }

        if (state === 'escape') {
          if (char === '[') {
            state = 'csi'
            continue
          }

          if (char === ']') {
            state = 'osc'
            continue
          }

          if (char === 'P' || char === '^' || char === '_' || char === 'X') {
            state = 'string'
            continue
          }

          state = 'normal'

          if (char === '\r' || char === '\n' || char === '\u0008' || char === '\t' || char === '\u007f' || char >= ' ') {
            filtered += char
          }

          continue
        }

        if (state === 'csi') {
          if (code >= 0x40 && code <= 0x7e) {
            state = 'normal'
          }

          continue
        }

        if (state === 'osc') {
          if (char === '\u0007') {
            state = 'normal'
            continue
          }

          if (char === '\u001b') {
            state = 'oscEscape'
            continue
          }

          continue
        }

        if (state === 'oscEscape') {
          state = 'normal'
          continue
        }

        if (state === 'string') {
          if (char === '\u001b') {
            state = 'stringEscape'
          }

          continue
        }

        if (state === 'stringEscape') {
          state = 'normal'
        }
      }

      return {
        text: filtered,
        state,
      }
    }

    const processTerminalInput = (buffer: Buffer): void => {
      const filtered = filterTerminalText(buffer.toString('utf8'), inputControlSequenceState)
      const text = filtered.text

      inputControlSequenceState = filtered.state

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          const submittedLine = pendingInput
          const command = pendingInput.trim()

          if (heredoc) {
            if (isHeredocTerminator(submittedLine, heredoc)) {
              heredoc = null
            }

            pendingInput = ''
            updateHeader('command input')
            continue
          }

          const startedCommand = Boolean(command)

          if (command) {
            const nextHeredoc = getSimpleHeredocState(command)

            if (nextHeredoc) {
              heredoc = nextHeredoc
            }

            lastCommand = command

            if (currentBlock) {
              currentBlock.output = trimTrailingEchoedInputFromOutput(currentBlock.output, submittedLine, command)
              currentBlock.active = false
            }

            currentBlock = {
              command,
              output: '',
              active: true,
              truncated: false,
              startMarker: registerBlockStartMarker(0),
            }
            commandBlocks.push(currentBlock)
            trimCommandBlocks()
          }

          pendingInput = ''
          updateHeader(startedCommand ? 'command start' : 'command input')

          continue
        }

        if (char === '\u0008' || char === '\u007f') {
          pendingInput = pendingInput.slice(0, -1)
          continue
        }

        if (char === '\t' || char >= ' ') {
          pendingInput += char
        }
      }
    }

    const processSessionOutput = (buffer: Buffer): void => {
      if (!currentBlock || alternateScreenActive) {
        return
      }

      const filtered = filterTerminalText(buffer.toString('utf8'), outputControlSequenceState)
      let text = filtered.text

      outputControlSequenceState = filtered.state

      if (!text) {
        return
      }

      text = text.replace(/\r\n/g, '\n')

      if (!currentBlock.output && !currentBlock.startMarker) {
        currentBlock.startMarker = registerBlockStartMarker(0)
      }

      currentBlock.output += text

      if (currentBlock.output.length > MAX_OUTPUT_CHARS_PER_BLOCK) {
        currentBlock.output = currentBlock.output.slice(-MAX_OUTPUT_CHARS_PER_BLOCK)
        currentBlock.truncated = true
      }

      updateHeader('command output')
    }

    const writeClipboardText = async (text: string): Promise<void> => {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }

      const textarea = document.createElement('textarea')

      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()

      try {
        if (!document.execCommand('copy')) {
          throw new Error('copy command rejected')
        }
      } finally {
        textarea.remove()
      }
    }

    const copyCurrentOutput = async (): Promise<void> => {
      debugResolver('copy click before update')
      updateHeader('copy click after update')
      const block = getCopyableBlock()
      debugResolver('copy click selected block')

      if (!block) {
        setStatus('No output')
        return
      }

      const copiedText = [
        `$ ${block.command}`,
        block.truncated ? '[Output truncated to the most recent retained text]' : '',
        formatOutputForCopy(
          trimRetainedOutputAtNextCommandBoundary(block.output, getNextCommandForBlock(block)),
        ).trimEnd(),
      ].filter(Boolean).join('\n')

      try {
        await writeClipboardText(copiedText)
        setStatus('Copied')
      } catch {
        setStatus('Copy failed')
      }
    }

    const handleCopyClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      void copyCurrentOutput()
    }

    copyButton.addEventListener('click', handleCopyClick)

    const detachCapture = (): void => {
      if (
        capture &&
        captureMiddlewareStack &&
        typeof captureMiddlewareStack.remove === 'function'
      ) {
        captureMiddlewareStack.remove(capture)
      }

      capture = null
      captureMiddlewareStack = null

      if (inputSubscription) {
        inputSubscription.unsubscribe()
        inputSubscription = null
      }
    }

    const attachCapture = (): void => {
      detachCapture()

      const middlewareStack = terminal.session?.middleware

      if (middlewareStack && typeof middlewareStack.push === 'function') {
        capture = new StickyCommandHeaderCapture(processTerminalInput, processSessionOutput)
        captureMiddlewareStack = middlewareStack
        middlewareStack.push(capture)
        return
      }

      inputSubscription = terminal.input$.subscribe(processTerminalInput)
      this.subscribeUntilDetached(terminal, inputSubscription)
    }

    attachCapture()

    if (terminal.sessionChanged$) {
      const sessionChangedSubscription = terminal.sessionChanged$.subscribe(() => {
        pendingInput = ''
        heredoc = null
        inputControlSequenceState = 'normal'
        outputControlSequenceState = 'normal'
        currentBlock = null
        clearCommandBlocks()
        lastCommand = ''
        attachCapture()
        updateHeader('attach')
      })

      this.subscribeUntilDetached(terminal, sessionChangedSubscription)
    }

    const alternateScreenSubscription = terminal.alternateScreenActive$.subscribe(active => {
      alternateScreenActive = active
      updateHeader('content update')
    })

    this.subscribeUntilDetached(terminal, alternateScreenSubscription)

    const frontendReadySubscription = terminal.frontendReady$.subscribe(() => {
      window.setTimeout(findViewport, 250)
      attachXtermEventDiagnostics()

      if (terminal.frontend) {
        const contentSubscription = terminal.frontend.contentUpdated$.subscribe(() => updateHeader('content update'))

        this.subscribeUntilDetached(terminal, contentSubscription)
      }
    })

    this.subscribeUntilDetached(terminal, frontendReadySubscription)

    attachXtermEventDiagnostics()
    window.setTimeout(findViewport, 500)

    this.cleanup.set(terminal, () => {
      detachCapture()

      if (statusTimeout !== null) {
        window.clearTimeout(statusTimeout)
        statusTimeout = null
      }

      clearCommandBlocks()
      copyButton.removeEventListener('click', handleCopyClick)

      if (viewport) {
        viewport.removeEventListener('scroll', handleDomScroll)
      }

      xtermScrollSubscription?.dispose?.()
      xtermScrollSubscription = null
      xtermResizeSubscription?.dispose?.()
      xtermResizeSubscription = null

      header.remove()
    })
  }

  detach (terminal: any): void {
    this.cleanup.get(terminal)?.()
    this.cleanup.delete(terminal)

    super.detach(terminal)
  }
}
