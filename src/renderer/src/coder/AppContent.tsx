import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useSolutionStore } from '@/lib/store/solution'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'

const SCROLL_OFFSET = 120

export function AppContent() {
  const {
    screenshotData,
    solutionChunks,
    errorMessage,
    isLoading,
    setScreenshotData,
    setIsLoading,
    addSolutionChunk,
    setErrorMessage,
    clearSolution
  } = useSolutionStore()

  const [recentScreenshots, setRecentScreenshots] = useState<string[]>([])

  useEffect(() => {
    // Listen for screenshot events (latest)
    window.api.onScreenshotTaken((data: string) => {
      setScreenshotData(data)
    })

    // Listen for screenshots-updated events (gallery)
    window.api.onScreenshotsUpdated((screenshots: string[]) => {
      setRecentScreenshots(screenshots)
      if (screenshots.length === 0) setScreenshotData(null)
    })

    // Feedback for the copy-code shortcut
    window.api.onSolutionCopied((data) => {
      if (data.ok) toast.success(data.message)
      else toast.error(data.message)
    })

    // New session clear (pictures + answers)
    window.api.onSolutionClear(() => {
      clearSolution()
      setRecentScreenshots([])
      setScreenshotData(null)
      setErrorMessage(null)
    })

    // Listen for solution chunks
    window.api.onSolutionChunk((chunk: string) => {
      addSolutionChunk(chunk)
    })

    // AI loading
    window.api.onAiLoadingStart(() => {
      setIsLoading(true)
      setErrorMessage(null) // Clear error when new request starts
    })
    window.api.onAiLoadingEnd(() => {
      setIsLoading(false)
    })

    // Cleanup listeners on unmount
    return () => {
      window.api.removeScreenshotListener()
      window.api.removeScreenshotsUpdatedListener()
      window.api.removeSolutionChunkListener()
      window.api.removeAiLoadingStartListener()
      window.api.removeAiLoadingEndListener()
      window.api.removeSolutionClearListener()
      window.api.removeSolutionCopiedListener()
    }
  }, [setScreenshotData, clearSolution, setIsLoading, addSolutionChunk, setErrorMessage])

  useEffect(() => {
    window.api.onSolutionComplete(() => {
      setIsLoading(false)
    })
    window.api.onSolutionStopped(() => {
      setIsLoading(false)
    })
    window.api.onSolutionError((message: string) => {
      setIsLoading(false)
      setErrorMessage(message)
    })
    return () => {
      window.api.removeSolutionCompleteListener()
      window.api.removeSolutionStoppedListener()
      window.api.removeSolutionErrorListener()
    }
  }, [setIsLoading, setErrorMessage])

  useEffect(() => {
    window.api.onScrollPageUp(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop - window.innerHeight + SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageUpListener()
    }
  }, [])

  useEffect(() => {
    window.api.onScrollPageDown(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop + window.innerHeight - SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageDownListener()
    }
  }, [])

  return (
    <div id="app-content" className="px-6 py-4">
      {/* Error Banner */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-red-400 font-medium text-sm">API 调用失败</p>
            <p className="text-red-300/80 text-sm mt-0.5 break-words">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400/80 hover:text-red-300 flex-shrink-0"
            title="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Screenshot Gallery */}
      {recentScreenshots.length > 0 ? (
        <div className="mb-4 flex gap-4 overflow-x-auto p-2">
          {recentScreenshots.map((data, index) => (
            <div key={index} className="relative group flex-shrink-0">
              <img
                src={`data:image/png;base64,${data}`}
                alt={`Screenshot ${index + 1}`}
                className="w-40 h-auto border border-gray-600 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
                title={`第 ${index + 1} 张截图`}
              />
              <button
                className="absolute -top-2 -right-2 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white shadow-md hover:bg-red-600 transition-colors"
                title="删除截图"
                onClick={() => void window.api.deleteScreenshot(index)}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      ) : screenshotData ? (
        <div className="mb-4">
          <img
            src={`data:image/png;base64,${screenshotData}`}
            alt="Screenshot"
            className="w-40 h-auto border border-gray-600 rounded-lg shadow-lg"
          />
        </div>
      ) : (
        <ShortcutTip />
      )}

      {/* Staged screenshot actions: trigger AI or clear everything */}
      {recentScreenshots.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-md hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            disabled={isLoading}
            onClick={() => void window.api.triggerAction('triggerSolution')}
          >
            🚀 触发 AI 思考
          </button>
          <button
            className="rounded-lg border border-red-400/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20 transition-colors"
            onClick={() => void window.api.triggerAction('clearScreenshots')}
          >
            🗑️ 清空
          </button>
        </div>
      )}

      {/* Solution Display */}
      <MarkdownRenderer>{solutionChunks.join('')}</MarkdownRenderer>
    </div>
  )
}

function ShortcutTip() {
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="flex items-center justify-center h-full text-xl text-gray-400 select-none">
      请按下快捷键
      <ShortcutRenderer
        shortcut={shortcuts.takeScreenshot.key}
        className="mx-1 font-bold text-black"
      />
      抓取屏幕进行分析
    </div>
  )
}
