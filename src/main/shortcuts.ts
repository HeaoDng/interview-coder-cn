import { clipboard, globalShortcut, ipcMain, screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import type { ModelMessage } from 'ai'
import { applyContentProtection } from './main-window'
import {
  showToolbar,
  hideToolbar,
  setToolbarWanted,
  reassertToolbarTopMost
} from './toolbar-window'
import { takeScreenshot } from './take-screenshot'
import { compressForApi } from './image-compression'
import { saveScreenshotToDisk } from './save-screenshot'
import { getSolutionStream, getFollowUpStream, getGeneralStream } from './ai'
import { state } from './state'
import { settings } from './settings'
import { getTranscriptionText, clearTranscriptionText } from './transcription'

/**
 * Extract meaningful error message from API errors
 */
function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    const text = String(error)
    if (text) return text
    try {
      return JSON.stringify(error) || '未知错误'
    } catch {
      return '未知错误'
    }
  }

  // Try to extract responseBody from AI SDK errors
  const apiError = error as Error & {
    responseBody?: string
    statusCode?: number
    data?: unknown
  }

  // Try to parse responseBody for detailed message
  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody)
      if (body.message) {
        return body.message
      }
      if (body.error?.message) {
        return body.error.message
      }
    } catch {
      // If parsing fails, use responseBody as is
      if (typeof apiError.responseBody === 'string' && apiError.responseBody.length < 200) {
        return apiError.responseBody
      }
    }
  }

  // Fallback to error message; include the cause chain ("fetch failed" errors
  // carry the real reason, e.g. HeadersTimeoutError, inside .cause)
  let message = [error.name === 'Error' ? '' : error.name, error.message]
    .filter(Boolean)
    .join(': ')
  let cause = (error as { cause?: unknown }).cause
  let depth = 0
  while (cause instanceof Error && depth < 3) {
    const causeText = cause.message || cause.name
    if (causeText && !message.includes(causeText)) {
      message = message ? `${message} (${causeText})` : causeText
    }
    cause = (cause as { cause?: unknown }).cause
    depth++
  }

  return message || '未知错误'
}

/**
 * Extract fenced code blocks (```...```) from a markdown string.
 * Falls back to a trailing unterminated fence (e.g. generation was interrupted).
 */
function extractFencedCode(text: string): string[] {
  const blocks: string[] = []
  const fenceRegex = /```[^\n]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match[1].trim()) blocks.push(match[1].trim())
  }
  if (blocks.length === 0) {
    const openMatch = text.match(/```[^\n]*\n([\s\S]*)/)
    if (openMatch && openMatch[1].trim()) {
      blocks.push(openMatch[1].trim())
    }
  }
  return blocks
}

type Shortcut = {
  action: string
  key: string
  status: ShortcutStatus
  registeredKeys: string[]
}

enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

const MOVE_STEP = 200
/** Opacity delta per shortcut press, matching the settings slider step */
const OPACITY_STEP = 0.05
const shortcuts: Record<string, Shortcut> = {}

type AbortReason = 'user' | 'new-request'

interface StreamContext {
  controller: AbortController
  reason: AbortReason | null
}

let currentStreamContext: StreamContext | null = null

// Conversation history tracking
let conversationMessages: ModelMessage[] = []
let recentScreenshots: string[] = [] // 最近截图，水平预览 (限5张)
let hasAppendSeparator = false

/** Remove the image matching `imageData` from the conversation history (latest match wins) */
function removeImageFromConversation(imageData: string) {
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const message = conversationMessages[i]
    if (message.role !== 'user' || typeof message.content === 'string') continue
    const parts = message.content as Array<{ type: string; image?: unknown }>
    const imageIndex = parts.findIndex((part) => part.type === 'image' && part.image === imageData)
    if (imageIndex === -1) continue
    parts.splice(imageIndex, 1)
    if (parts.length === 0) {
      conversationMessages.splice(i, 1)
    }
    return
  }
}

/** Remove a screenshot at `index` from the gallery and the conversation history */
function removeScreenshotAt(index: number): boolean {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (!Number.isInteger(index) || index < 0 || index >= recentScreenshots.length) return false

  const [removed] = recentScreenshots.splice(index, 1)
  removeImageFromConversation(removed)
  mainWindow.webContents.send('screenshots-updated', recentScreenshots)
  return true
}

const FRONT_REASSERT_DURATION = 8000
const FRONT_REASSERT_INTERVAL = 100
const FRONT_RELATIVE_LEVEL = 100
const BACKGROUND_GUARD_INTERVAL = 2000
let frontReassertTimer: NodeJS.Timeout | null = null
let backgroundGuardTimer: NodeJS.Timeout | null = null
let isWindowSoftHidden = false
let softHiddenBounds: Rectangle | null = null

/**
 * Reassert always-on-top. `aggressive` also calls moveTop() which
 * brings the window above everything — only use on explicit user actions
 * (show, screenshot, etc.) to avoid disturbing interaction with other apps.
 */
function applyTopMost(win: BrowserWindow, aggressive = true) {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver', FRONT_RELATIVE_LEVEL)
  if (aggressive) win.moveTop()

  if (state.ignoreMouse) {
    reassertToolbarTopMost(FRONT_RELATIVE_LEVEL + 1, aggressive)
  }
}

/**
 * Start a persistent low-frequency background guard that continuously
 * re-asserts always-on-top while the window is visible.
 * Uses the non-aggressive variant so it won't steal focus or
 * interfere with the user's interaction with other windows.
 */
function startBackgroundGuard(window: BrowserWindow) {
  if (backgroundGuardTimer) return // already running
  backgroundGuardTimer = setInterval(() => {
    if (!window || window.isDestroyed() || !window.isVisible()) {
      stopBackgroundGuard()
      return
    }
    applyTopMost(window, false)
  }, BACKGROUND_GUARD_INTERVAL)
}

function stopBackgroundGuard() {
  if (backgroundGuardTimer) {
    clearInterval(backgroundGuardTimer)
    backgroundGuardTimer = null
  }
}

function stopFrontReassert() {
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }
}

function getOffscreenBounds(window: BrowserWindow): Rectangle {
  const displays = screen.getAllDisplays()
  const maxRight = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const topMost = Math.min(...displays.map((display) => display.bounds.y))
  const [width, height] = window.getSize()

  return {
    x: maxRight + 2000,
    y: topMost,
    width,
    height
  }
}

function softHideWindow(window: BrowserWindow) {
  if (isWindowSoftHidden || window.isDestroyed()) return

  stopFrontReassert()
  stopBackgroundGuard()
  softHiddenBounds = window.getBounds()
  isWindowSoftHidden = true

  window.setOpacity(0)
  window.setIgnoreMouseEvents(true)
  window.setBounds(getOffscreenBounds(window))
  hideToolbar()
}

function restoreSoftHiddenWindow(window: BrowserWindow) {
  if (!isWindowSoftHidden || !softHiddenBounds || window.isDestroyed()) return

  applyContentProtection(window, true)
  window.setBounds(softHiddenBounds)
  window.setIgnoreMouseEvents(state.ignoreMouse)
  window.setOpacity(1)

  isWindowSoftHidden = false
  softHiddenBounds = null
  showToolbar()
  keepWindowInFront(window)
}

function showMainWindow(window: BrowserWindow) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    window.showInactive()
  } else {
    window.show()
  }

  applyContentProtection(window, process.platform === 'win32')
  showToolbar()
  keepWindowInFront(window)
}

function keepWindowInFront(window: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }

  const start = Date.now()
  const reassert = () => {
    if (!window.isVisible() || window.isDestroyed()) return false
    applyTopMost(window)
    return true
  }

  if (!reassert()) return

  // Aggressive burst: rapid reasserts for a short period
  frontReassertTimer = setInterval(() => {
    const shouldStop = Date.now() - start > FRONT_REASSERT_DURATION
    if (shouldStop || !reassert()) {
      if (frontReassertTimer) {
        clearInterval(frontReassertTimer)
        frontReassertTimer = null
      }
    }
  }, FRONT_REASSERT_INTERVAL)

  // Ensure background guard is running for persistent protection
  startBackgroundGuard(window)
}

/**
 * Opacity is owned by the renderer settings store (persisted + synced back to
 * main), so the shortcut only asks the renderer to step it.
 */
function adjustOpacity(delta: number) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
  mainWindow.webContents.send('adjust-opacity', delta)
}

function abortCurrentStream(reason: AbortReason) {
  if (!currentStreamContext) return
  currentStreamContext.reason = reason
  currentStreamContext.controller.abort()
}

const callbacks: Record<string, () => void> = {
  hideOrShowMainWindow: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    if (process.platform === 'win32') {
      if (isWindowSoftHidden) {
        restoreSoftHiddenWindow(mainWindow)
        return
      }

      if (!mainWindow.isVisible()) {
        showMainWindow(mainWindow)
        return
      }

      softHideWindow(mainWindow)
      return
    }

    if (mainWindow.isVisible()) {
      stopBackgroundGuard()
      mainWindow.hide()
    } else {
      // 重新显示时不断重申置顶属性，抵消其他前台软件持续抢占
      showMainWindow(mainWindow)
    }
  },

  takeScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    abortCurrentStream('new-request')
    let loadingStarted = false
    const screenshotData = await takeScreenshot()
    if (screenshotData && mainWindow && !mainWindow.isDestroyed()) {
      // Another capture may have claimed the stream while we were capturing
      if (currentStreamContext) {
        currentStreamContext.reason = 'new-request'
        currentStreamContext.controller.abort()
      }
      saveScreenshotToDisk(screenshotData)
      const transcriptionText = getTranscriptionText()
      if (transcriptionText) {
        clearTranscriptionText()
        mainWindow.webContents.send('transcription-cleared')
      }
      conversationMessages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: transcriptionText
                ? `这是语音转录内容：\n${transcriptionText}\n\n同时附上屏幕截图：`
                : '这是屏幕截图'
            },
            {
              type: 'image',
              image: compressForApi(screenshotData)
            }
          ]
        }
      ]

      const streamContext: StreamContext = {
        controller: new AbortController(),
        reason: null
      }
      currentStreamContext = streamContext
      recentScreenshots = [screenshotData]
      hasAppendSeparator = false
      mainWindow.webContents.send('solution-clear')
      mainWindow.webContents.send('screenshots-updated', recentScreenshots)
      mainWindow.webContents.send('screenshot-taken', screenshotData)
      mainWindow.webContents.send('ai-loading-start')
      loadingStarted = true
      let endedNaturally = true
      let streamStarted = false
      let assistantResponse = ''
      try {
        const solutionStream = getSolutionStream(
          conversationMessages,
          streamContext.controller.signal
        )
        streamStarted = true
        try {
          for await (const chunk of solutionStream) {
            if (streamContext.controller.signal.aborted) {
              endedNaturally = false
              break
            }
            assistantResponse += chunk
            mainWindow.webContents.send('solution-chunk', chunk)
          }
        } catch (error) {
          if (!streamContext.controller.signal.aborted) {
            endedNaturally = false
            console.error('Error streaming solution:', error)
            mainWindow.webContents.send('solution-error', extractErrorMessage(error))
          } else {
            endedNaturally = false
          }
        }

        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else if (endedNaturally) {
          // Add assistant response to conversation history
          if (assistantResponse) {
            conversationMessages.push({
              role: 'assistant',
              content: assistantResponse
            })
          }
          mainWindow.webContents.send('solution-complete')
        }
      } catch (error) {
        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else {
          endedNaturally = false
          console.error('Error streaming solution:', error)
          mainWindow.webContents.send('solution-error', extractErrorMessage(error))
        }
      } finally {
        // Only the stream that is still current owns the loading state; a
        // superseded stream must not end the loading of its replacement
        const isCurrent = currentStreamContext === streamContext
        if (isCurrent) {
          currentStreamContext = null
        }
        if (!streamStarted && streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
        if (loadingStarted && isCurrent && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai-loading-end')
        }
      }
    }
  },

  // Append screenshot for continuous capture (if conversation exists)
  appendScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    // Fallback to first screenshot if no conversation
    if (conversationMessages.length === 0) {
      callbacks.takeScreenshot()
      return
    }

    abortCurrentStream('new-request')
    let loadingStarted = false

    const screenshotData = await takeScreenshot()
    if (screenshotData && mainWindow && !mainWindow.isDestroyed()) {
      // Another capture may have claimed the stream while we were capturing
      if (currentStreamContext) {
        currentStreamContext.reason = 'new-request'
        currentStreamContext.controller.abort()
      }
      saveScreenshotToDisk(screenshotData)
      const transcriptionText = getTranscriptionText()
      if (transcriptionText) {
        clearTranscriptionText()
        mainWindow.webContents.send('transcription-cleared')
      }
      // Append new image message to conversation
      const newUserMessage: ModelMessage = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: transcriptionText
              ? `这是下一部分截图和语音转录内容：\n${transcriptionText}\n请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。`
              : '这是下一部分截图，请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。'
          },
          {
            type: 'image',
            image: compressForApi(screenshotData)
          }
        ]
      }
      conversationMessages.push(newUserMessage)

      const streamContext: StreamContext = {
        controller: new AbortController(),
        reason: null
      }
      currentStreamContext = streamContext

      recentScreenshots.push(screenshotData)
      recentScreenshots = recentScreenshots.slice(-5) // 限5张
      mainWindow.webContents.send('screenshot-taken', screenshotData)
      mainWindow.webContents.send('screenshots-updated', recentScreenshots)
      if (!hasAppendSeparator) {
        mainWindow.webContents.send('solution-chunk', '\n\n---\n\n')
        hasAppendSeparator = true
      } else {
        mainWindow.webContents.send('solution-chunk', '\n\n')
      }
      mainWindow.webContents.send('ai-loading-start')
      loadingStarted = true

      let endedNaturally = true
      let streamStarted = false
      let assistantResponse = ''
      try {
        const solutionStream = getGeneralStream(
          conversationMessages,
          streamContext.controller.signal
        )
        streamStarted = true
        try {
          for await (const chunk of solutionStream) {
            if (streamContext.controller.signal.aborted) {
              endedNaturally = false
              break
            }
            assistantResponse += chunk
            mainWindow.webContents.send('solution-chunk', chunk)
          }
        } catch (error) {
          if (!streamContext.controller.signal.aborted) {
            endedNaturally = false
            console.error('Error streaming continuous solution:', error)
            mainWindow.webContents.send('solution-error', extractErrorMessage(error))
          } else {
            endedNaturally = false
          }
        }

        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else if (endedNaturally) {
          // Add assistant response to conversation history
          if (assistantResponse) {
            conversationMessages.push({
              role: 'assistant',
              content: assistantResponse
            })
          }
          mainWindow.webContents.send('solution-complete')
        }
      } catch (error) {
        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else {
          endedNaturally = false
          console.error('Error streaming continuous solution:', error)
          mainWindow.webContents.send('solution-error', extractErrorMessage(error))
        }
      } finally {
        const isCurrent = currentStreamContext === streamContext
        if (isCurrent) {
          currentStreamContext = null
        }
        if (!streamStarted && streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
        if (loadingStarted && isCurrent && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai-loading-end')
        }
      }
    }
  },

  // Stop current AI solution stream
  stopSolutionStream: () => {
    abortCurrentStream('user')
  },

  // Copy the latest model-output code to the clipboard
  copySolutionCode: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return

    const assistantTexts: string[] = []
    conversationMessages.forEach((message) => {
      if (message.role !== 'assistant') return
      if (typeof message.content === 'string') {
        assistantTexts.push(message.content)
      } else if (Array.isArray(message.content)) {
        assistantTexts.push(
          message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
        )
      }
    })

    let result = { ok: false, message: '暂无可复制的代码' }
    let copied = false
    for (let i = assistantTexts.length - 1; i >= 0 && !copied; i--) {
      const codeBlocks = extractFencedCode(assistantTexts[i])
      if (codeBlocks.length > 0) {
        clipboard.writeText(codeBlocks.join('\n\n'))
        result = { ok: true, message: '代码已复制到剪贴板' }
        copied = true
      }
    }
    if (!copied && assistantTexts.length > 0) {
      clipboard.writeText(assistantTexts[assistantTexts.length - 1])
      result = { ok: true, message: '未找到代码块，已复制完整回答' }
    }
    mainWindow.webContents.send('solution-copied', result)
  },

  // Delete the most recent screenshot (gallery + conversation history)
  deleteLastScreenshot: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    if (recentScreenshots.length === 0) return
    removeScreenshotAt(recentScreenshots.length - 1)
  },

  // Stage a screenshot into the gallery WITHOUT calling the AI
  captureScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    const screenshotData = await takeScreenshot()
    if (!screenshotData || mainWindow.isDestroyed()) return

    saveScreenshotToDisk(screenshotData)
    recentScreenshots.push(screenshotData)
    recentScreenshots = recentScreenshots.slice(-5) // 限5张
    mainWindow.webContents.send('screenshots-updated', recentScreenshots)
  },

  // Trigger AI analysis over all staged screenshots (starts a fresh conversation)
  triggerSolution: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    // Nothing staged yet: fall back to the classic capture-and-solve flow
    if (recentScreenshots.length === 0) {
      callbacks.takeScreenshot()
      return
    }

    abortCurrentStream('new-request')
    const transcriptionText = getTranscriptionText()
    if (transcriptionText) {
      clearTranscriptionText()
      mainWindow.webContents.send('transcription-cleared')
    }

    const imageCount = recentScreenshots.length
    const screenshotText =
      imageCount > 1 ? `这些是${imageCount}张屏幕截图，请结合所有截图分析解答` : '这是屏幕截图'
    conversationMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: transcriptionText
              ? `这是语音转录内容：\n${transcriptionText}\n\n${screenshotText}`
              : screenshotText
          },
          ...recentScreenshots.map((image) => ({
            type: 'image' as const,
            image: compressForApi(image)
          }))
        ]
      }
    ]

    const streamContext: StreamContext = {
      controller: new AbortController(),
      reason: null
    }
    currentStreamContext = streamContext
    hasAppendSeparator = false
    mainWindow.webContents.send('solution-clear')
    // solution-clear also wipes the renderer-side gallery; restore the staged
    // screenshots so they stay visible for deletion or another trigger
    mainWindow.webContents.send('screenshots-updated', recentScreenshots)
    mainWindow.webContents.send('ai-loading-start')

    let endedNaturally = true
    let streamStarted = false
    let assistantResponse = ''
    try {
      const solutionStream = getGeneralStream(
        conversationMessages,
        streamContext.controller.signal
      )
      streamStarted = true
      try {
        for await (const chunk of solutionStream) {
          if (streamContext.controller.signal.aborted) {
            endedNaturally = false
            break
          }
          assistantResponse += chunk
          mainWindow.webContents.send('solution-chunk', chunk)
        }
      } catch (error) {
        if (!streamContext.controller.signal.aborted) {
          endedNaturally = false
          console.error('Error streaming staged solution:', error)
          mainWindow.webContents.send('solution-error', extractErrorMessage(error))
        } else {
          endedNaturally = false
        }
      }

      if (streamContext.controller.signal.aborted) {
        if (streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
      } else if (endedNaturally) {
        // Add assistant response to conversation history
        if (assistantResponse) {
          conversationMessages.push({
            role: 'assistant',
            content: assistantResponse
          })
        }
        mainWindow.webContents.send('solution-complete')
      }
    } catch (error) {
      if (streamContext.controller.signal.aborted) {
        if (streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
      } else {
        endedNaturally = false
        console.error('Error streaming staged solution:', error)
        mainWindow.webContents.send('solution-error', extractErrorMessage(error))
      }
    } finally {
      const isCurrent = currentStreamContext === streamContext
      if (isCurrent) {
        currentStreamContext = null
      }
      if (!streamStarted && streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
      if (isCurrent && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai-loading-end')
      }
    }
  },

  // Clear all staged screenshots and reset the conversation
  clearScreenshots: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return

    abortCurrentStream('user')
    recentScreenshots = []
    conversationMessages = []
    hasAppendSeparator = false
    mainWindow.webContents.send('screenshots-updated', recentScreenshots)
    mainWindow.webContents.send('solution-clear')
  },

  ignoreOrEnableMouse: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    state.ignoreMouse = !state.ignoreMouse
    mainWindow.setIgnoreMouseEvents(state.ignoreMouse)
    showToolbar()
    mainWindow.webContents.send('sync-app-state', state)
  },

  increaseOpacity: () => {
    adjustOpacity(OPACITY_STEP)
  },

  decreaseOpacity: () => {
    adjustOpacity(-OPACITY_STEP)
  },

  pageUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('scroll-page-up')
  },

  pageDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('scroll-page-down')
  },

  moveMainWindowUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y - MOVE_STEP)
  },

  moveMainWindowDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y + MOVE_STEP)
  },

  moveMainWindowLeft: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x - MOVE_STEP, y)
  },

  moveMainWindowRight: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + MOVE_STEP, y)
  },

  toggleTranscription: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('toggle-transcription')
  },

  clearTranscription: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    clearTranscriptionText()
    mainWindow.webContents.send('transcription-cleared')
  }
}

const clickableActions = new Set([
  'takeScreenshot',
  'appendScreenshot',
  'captureScreenshot',
  'triggerSolution',
  'clearScreenshots',
  'stopSolutionStream',
  'ignoreOrEnableMouse',
  'increaseOpacity',
  'decreaseOpacity',
  'pageUp',
  'pageDown',
  'moveMainWindowUp',
  'moveMainWindowDown',
  'moveMainWindowLeft',
  'moveMainWindowRight',
  'toggleTranscription',
  'clearTranscription'
])

function unregisterShortcut(action: string) {
  const shortcut = shortcuts[action]
  if (!shortcut) return
  if (shortcut.registeredKeys.length) {
    shortcut.registeredKeys.forEach((registeredKey) => {
      globalShortcut.unregister(registeredKey)
    })
  } else {
    globalShortcut.unregister(shortcut.key)
  }
  shortcut.status = ShortcutStatus.Available
  shortcut.registeredKeys = []
}

function getShortcutRegistrationKeys(key: string) {
  const keys = [key]
  if (process.platform !== 'win32') {
    return keys
  }
  const parts = key.split('+')
  const hasAlt = parts.includes('Alt')
  const hasCtrl = parts.includes('CommandOrControl') || parts.includes('Control')
  if (hasAlt && !hasCtrl) {
    const aliasParts = [...parts]
    const altIndex = aliasParts.indexOf('Alt')
    if (altIndex >= 0) {
      aliasParts.splice(altIndex, 0, 'CommandOrControl')
      const aliasKey = aliasParts.join('+')
      if (!keys.includes(aliasKey)) {
        keys.push(aliasKey)
      }
    }
  }
  return keys
}

function registerShortcut(action: string, key: string) {
  if (shortcuts[action]) {
    unregisterShortcut(action)
  }

  const keysToRegister = getShortcutRegistrationKeys(key)
  const registeredKeys: string[] = []
  keysToRegister.forEach((shortcutKey) => {
    if (globalShortcut.register(shortcutKey, callbacks[action])) {
      registeredKeys.push(shortcutKey)
    }
  })

  shortcuts[action] = {
    action,
    key,
    status: registeredKeys.length ? ShortcutStatus.Registered : ShortcutStatus.Failed,
    registeredKeys
  }
}

ipcMain.handle('getShortcuts', () => shortcuts)

ipcMain.handle(
  'initShortcuts',
  (_event, shortcuts: Record<string, { action: string; key: string }>) => {
    Object.entries(shortcuts).forEach(([action, { key }]) => {
      registerShortcut(action, key)
    })
  }
)

ipcMain.handle('updateShortcuts', (_event, _shortcuts: { action: string; key: string }[]) => {
  _shortcuts.forEach((shortcut) => {
    if (shortcuts[shortcut.action]?.key !== shortcut.key) {
      registerShortcut(shortcut.action, shortcut.key)
    }
  })
})

ipcMain.handle('stopSolutionStream', () => {
  if (!currentStreamContext) return false
  abortCurrentStream('user')
  return true
})

// Delete a screenshot (by gallery index) from the session and the conversation history
ipcMain.handle('delete-screenshot', (_event, index: number) => removeScreenshotAt(index))

// Current staged screenshots, so the renderer can restore the gallery on remount
ipcMain.handle('get-recent-screenshots', () => recentScreenshots)

ipcMain.handle('triggerAction', (_event, action: string) => {
  if (!clickableActions.has(action)) return false
  callbacks[action]?.()
  return true
})

ipcMain.handle('setToolbarVisible', (_event, visible: boolean) => {
  setToolbarWanted(visible)
})

ipcMain.handle('sendFollowUpQuestion', async (_event, question: string) => {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) {
    return { success: false, error: 'Invalid state' }
  }

  // Validate that there's an active conversation
  if (conversationMessages.length === 0) {
    return { success: false, error: 'No active conversation' }
  }

  abortCurrentStream('new-request')
  const streamContext: StreamContext = {
    controller: new AbortController(),
    reason: null
  }
  currentStreamContext = streamContext

  // Add a separator before the follow-up response
  mainWindow.webContents.send('solution-chunk', '\n\n---\n\n')

  let endedNaturally = true
  let streamStarted = false
  let assistantResponse = ''

  try {
    const followUpStream = getFollowUpStream(
      conversationMessages,
      question,
      streamContext.controller.signal
    )
    streamStarted = true

    try {
      for await (const chunk of followUpStream) {
        if (streamContext.controller.signal.aborted) {
          endedNaturally = false
          break
        }
        assistantResponse += chunk
        mainWindow.webContents.send('solution-chunk', chunk)
      }
    } catch (error) {
      if (!streamContext.controller.signal.aborted) {
        endedNaturally = false
        console.error('Error streaming follow-up solution:', error)
        mainWindow.webContents.send('solution-error', extractErrorMessage(error))
      } else {
        endedNaturally = false
      }
    }

    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else if (endedNaturally) {
      // Update conversation history with user question and assistant response
      conversationMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: question
          }
        ]
      })
      if (assistantResponse) {
        conversationMessages.push({
          role: 'assistant',
          content: assistantResponse
        })
      }
      mainWindow.webContents.send('solution-complete')
    }
  } catch (error) {
    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else {
      endedNaturally = false
      console.error('Error streaming follow-up solution:', error)
      mainWindow.webContents.send('solution-error', extractErrorMessage(error))
    }
  } finally {
    if (currentStreamContext === streamContext) {
      currentStreamContext = null
    }
    if (!streamStarted && streamContext.reason === 'user') {
      mainWindow.webContents.send('solution-stopped')
    }
  }

  return { success: true }
})
