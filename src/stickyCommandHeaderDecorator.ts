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
}

const MAX_COMMAND_BLOCKS = 20
const MAX_OUTPUT_CHARS_PER_BLOCK = 256 * 1024
const COPY_STATUS_TIMEOUT_MS = 1800
const BRAILLE_SPINNER_FRAMES = new Set([
  '⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷',
  '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋',
])
const ASCII_SPINNER_FRAMES = new Set(['|', '/', '-', '\\'])
const SIMPLE_HEREDOC_OPERATOR = /(?:^|[\s;&|])<<-?\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_./-]+))(?=\s|$)/

const getSimpleHeredocDelimiter = (command: string): string | null => {
  const match = command.match(SIMPLE_HEREDOC_OPERATOR)

  return match ? match[1] || match[2] || match[3] : null
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

    const header = document.createElement('div')

    header.className = 'tabby-sticky-command-header'
    header.style.display = 'none'
    header.style.position = 'absolute'
    header.style.top = '0'
    header.style.left = '0'
    header.style.right = '0'
    header.style.zIndex = '100'
    header.style.padding = '4px 8px'
    header.style.fontFamily = 'var(--font-family, monospace)'
    header.style.fontSize = '12px'
    header.style.lineHeight = '18px'
    header.style.whiteSpace = 'nowrap'
    header.style.overflow = 'hidden'
    header.style.textOverflow = 'ellipsis'
    header.style.background = 'rgba(0, 0, 0, 0.82)'
    header.style.color = '#fff'
    header.style.pointerEvents = 'none'
    header.style.alignItems = 'center'
    header.style.gap = '8px'

    const commandLabel = document.createElement('span')

    commandLabel.style.flex = '1 1 auto'
    commandLabel.style.minWidth = '0'
    commandLabel.style.overflow = 'hidden'
    commandLabel.style.textOverflow = 'ellipsis'
    commandLabel.style.pointerEvents = 'none'

    const copyButton = document.createElement('button')

    copyButton.type = 'button'
    copyButton.textContent = 'Copy output'
    copyButton.style.flex = '0 0 auto'
    copyButton.style.border = '1px solid rgba(255, 255, 255, 0.35)'
    copyButton.style.borderRadius = '4px'
    copyButton.style.padding = '1px 6px'
    copyButton.style.font = 'inherit'
    copyButton.style.lineHeight = '16px'
    copyButton.style.background = 'rgba(255, 255, 255, 0.12)'
    copyButton.style.color = 'inherit'
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
    let heredocDelimiter: string | null = null
    let currentBlock: CommandBlock | null = null
    let commandBlocks: CommandBlock[] = []
    let alternateScreenActive = false
    let viewport: HTMLElement | null = null
    let inputControlSequenceState: ControlSequenceState = 'normal'
    let outputControlSequenceState: ControlSequenceState = 'normal'
    let statusTimeout: number | null = null
    let capture: StickyCommandHeaderCapture | null = null
    let captureMiddlewareStack: any = null
    let inputSubscription: any = null

    const isAtBottom = (): boolean => {
      if (!viewport) {
        return true
      }

      return viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4
    }

    const getCurrentCopyableBlock = (): CommandBlock | null => {
      if (!currentBlock || alternateScreenActive || !currentBlock.output.trim()) {
        return null
      }

      return currentBlock
    }

    const updateHeader = (): void => {
      if (!lastCommand || alternateScreenActive || isAtBottom()) {
        header.style.display = 'none'
        return
      }

      commandLabel.textContent = `Command: ${lastCommand}`
      copyButton.style.display = getCurrentCopyableBlock() ? 'inline-block' : 'none'
      header.style.display = 'flex'
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

    const findViewport = (): void => {
      viewport = host.querySelector('.xterm-viewport') as HTMLElement | null

      if (viewport) {
        viewport.addEventListener('scroll', updateHeader)
      }

      updateHeader()
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

          if (char === '\r' || char === '\n' || char === '\u0008' || char === '\u007f' || char >= ' ') {
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
          const command = pendingInput.trim()

          if (heredocDelimiter) {
            if (command === heredocDelimiter) {
              heredocDelimiter = null
            }

            pendingInput = ''
            updateHeader()
            continue
          }

          if (command) {
            const nextHeredocDelimiter = getSimpleHeredocDelimiter(command)

            if (nextHeredocDelimiter) {
              heredocDelimiter = nextHeredocDelimiter
            }

            lastCommand = command

            if (currentBlock) {
              currentBlock.active = false
            }

            currentBlock = {
              command,
              output: '',
              active: true,
              truncated: false,
            }
            commandBlocks.push(currentBlock)

            if (commandBlocks.length > MAX_COMMAND_BLOCKS) {
              commandBlocks = commandBlocks.slice(-MAX_COMMAND_BLOCKS)
            }
          }

          pendingInput = ''
          updateHeader()

          continue
        }

        if (char === '\u0008' || char === '\u007f') {
          pendingInput = pendingInput.slice(0, -1)
          continue
        }

        if (char >= ' ') {
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
      currentBlock.output += text

      if (currentBlock.output.length > MAX_OUTPUT_CHARS_PER_BLOCK) {
        currentBlock.output = currentBlock.output.slice(-MAX_OUTPUT_CHARS_PER_BLOCK)
        currentBlock.truncated = true
      }

      updateHeader()
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
      const block = getCurrentCopyableBlock()

      if (!block) {
        setStatus('No output')
        return
      }

      const copiedText = [
        `$ ${block.command}`,
        block.truncated ? '[Output truncated to the most recent retained text]' : '',
        formatOutputForCopy(block.output).trimEnd(),
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
        heredocDelimiter = null
        inputControlSequenceState = 'normal'
        outputControlSequenceState = 'normal'
        currentBlock = null
        commandBlocks = []
        lastCommand = ''
        attachCapture()
        updateHeader()
      })

      this.subscribeUntilDetached(terminal, sessionChangedSubscription)
    }

    const alternateScreenSubscription = terminal.alternateScreenActive$.subscribe(active => {
      alternateScreenActive = active
      updateHeader()
    })

    this.subscribeUntilDetached(terminal, alternateScreenSubscription)

    const frontendReadySubscription = terminal.frontendReady$.subscribe(() => {
      window.setTimeout(findViewport, 250)

      if (terminal.frontend) {
        const contentSubscription = terminal.frontend.contentUpdated$.subscribe(updateHeader)

        this.subscribeUntilDetached(terminal, contentSubscription)
      }
    })

    this.subscribeUntilDetached(terminal, frontendReadySubscription)

    window.setTimeout(findViewport, 500)

    this.cleanup.set(terminal, () => {
      detachCapture()

      if (statusTimeout !== null) {
        window.clearTimeout(statusTimeout)
        statusTimeout = null
      }

      copyButton.removeEventListener('click', handleCopyClick)

      if (viewport) {
        viewport.removeEventListener('scroll', updateHeader)
      }

      header.remove()
    })
  }

  detach (terminal: any): void {
    this.cleanup.get(terminal)?.()
    this.cleanup.delete(terminal)

    super.detach(terminal)
  }
}
