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

class StickyCommandHeaderInputCapture extends SessionMiddleware {
  constructor (private readonly onInput: (data: Buffer) => void) {
    super()
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

    host.appendChild(header)

    let pendingInput = ''
    let lastCommand = ''
    let alternateScreenActive = false
    let viewport: HTMLElement | null = null
    let controlSequenceState: ControlSequenceState = 'normal'
    let inputCapture: StickyCommandHeaderInputCapture | null = null
    let inputCaptureMiddlewareStack: any = null
    let inputSubscription: any = null

    const isAtBottom = (): boolean => {
      if (!viewport) {
        return true
      }

      return viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4
    }

    const updateHeader = (): void => {
      if (!lastCommand || alternateScreenActive || isAtBottom()) {
        header.style.display = 'none'
        return
      }

      header.textContent = `Command: ${lastCommand}`
      header.style.display = 'block'
    }

    const findViewport = (): void => {
      viewport = host.querySelector('.xterm-viewport') as HTMLElement | null

      if (viewport) {
        viewport.addEventListener('scroll', updateHeader)
      }

      updateHeader()
    }

    const filterTerminalInput = (text: string): string => {
      let filtered = ''

      for (const char of text) {
        const code = char.charCodeAt(0)

        if (controlSequenceState === 'normal') {
          if (char === '\u001b') {
            controlSequenceState = 'escape'
            continue
          }

          if (char === '\u009b') {
            controlSequenceState = 'csi'
            continue
          }

          if (char === '\u009d') {
            controlSequenceState = 'osc'
            continue
          }

          if (char === '\u0090' || char === '\u009e' || char === '\u009f') {
            controlSequenceState = 'string'
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

        if (controlSequenceState === 'escape') {
          if (char === '[') {
            controlSequenceState = 'csi'
            continue
          }

          if (char === ']') {
            controlSequenceState = 'osc'
            continue
          }

          if (char === 'P' || char === '^' || char === '_' || char === 'X') {
            controlSequenceState = 'string'
            continue
          }

          controlSequenceState = 'normal'

          if (char === '\r' || char === '\n' || char === '\u0008' || char === '\u007f' || char >= ' ') {
            filtered += char
          }

          continue
        }

        if (controlSequenceState === 'csi') {
          if (code >= 0x40 && code <= 0x7e) {
            controlSequenceState = 'normal'
          }

          continue
        }

        if (controlSequenceState === 'osc') {
          if (char === '\u0007') {
            controlSequenceState = 'normal'
            continue
          }

          if (char === '\u001b') {
            controlSequenceState = 'oscEscape'
            continue
          }

          continue
        }

        if (controlSequenceState === 'oscEscape') {
          controlSequenceState = 'normal'
          continue
        }

        if (controlSequenceState === 'string') {
          if (char === '\u001b') {
            controlSequenceState = 'stringEscape'
          }

          continue
        }

        if (controlSequenceState === 'stringEscape') {
          controlSequenceState = 'normal'
        }
      }

      return filtered
    }

    const processTerminalInput = (buffer: Buffer): void => {
      const text = filterTerminalInput(buffer.toString('utf8'))

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          const command = pendingInput.trim()

          if (command) {
            lastCommand = command
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

    const detachInputCapture = (): void => {
      if (
        inputCapture &&
        inputCaptureMiddlewareStack &&
        typeof inputCaptureMiddlewareStack.remove === 'function'
      ) {
        inputCaptureMiddlewareStack.remove(inputCapture)
      }

      inputCapture = null
      inputCaptureMiddlewareStack = null

      if (inputSubscription) {
        inputSubscription.unsubscribe()
        inputSubscription = null
      }
    }

    const attachInputCapture = (): void => {
      detachInputCapture()

      const middlewareStack = terminal.session?.middleware

      if (middlewareStack && typeof middlewareStack.push === 'function') {
        inputCapture = new StickyCommandHeaderInputCapture(processTerminalInput)
        inputCaptureMiddlewareStack = middlewareStack
        middlewareStack.push(inputCapture)
        return
      }

      inputSubscription = terminal.input$.subscribe(processTerminalInput)
      this.subscribeUntilDetached(terminal, inputSubscription)
    }

    attachInputCapture()

    if (terminal.sessionChanged$) {
      const sessionChangedSubscription = terminal.sessionChanged$.subscribe(() => {
        pendingInput = ''
        controlSequenceState = 'normal'
        attachInputCapture()
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
      detachInputCapture()

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