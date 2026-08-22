import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isMac, platformAlt } from '../utils/env'

export type Shortcut = {
  action: string
  key: string
  defaultKey: string
  category: string
  status?: ShortcutStatus
}

export enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

interface ShortcutsState {
  shortcuts: Record<string, Shortcut>
}

interface ShortcutsStore extends ShortcutsState {
  updateShortcut: (action: string, shortcut: Shortcut) => void
  updateShortcuts: (shortcuts: Record<string, Shortcut>) => void
  resetShortcuts: () => void
}

type PersistedShortcutsState = {
  shortcuts?: Record<string, Shortcut>
}

function isPersistedShortcutsState(value: unknown): value is PersistedShortcutsState {
  return typeof value === 'object' && value !== null && 'shortcuts' in value
}

const defaultShortcuts: Record<string, Omit<Shortcut, 'defaultKey'>> = {
  hideOrShowMainWindow: {
    action: 'hideOrShowMainWindow',
    key: `${platformAlt}+H`,
    category: 'Window Management'
  },
  ignoreOrEnableMouse: {
    action: 'ignoreOrEnableMouse',
    key: `${platformAlt}+M`,
    category: 'Window Management'
  },
  increaseOpacity: {
    action: 'increaseOpacity',
    key: `${platformAlt}+Shift+Up`,
    category: 'Window Management'
  },
  decreaseOpacity: {
    action: 'decreaseOpacity',
    key: `${platformAlt}+Shift+Down`,
    category: 'Window Management'
  },
  takeScreenshot: {
    action: 'takeScreenshot',
    key: `${platformAlt}+Enter`,
    category: 'Screenshot & AI'
  },
  captureScreenshot: {
    action: 'captureScreenshot',
    // Windows uses Ctrl-based combos: upstream found plain-Alt shortcuts steal
    // page focus there, and Alt+Space is the system window-menu accelerator
    key: isMac ? 'Alt+S' : 'CommandOrControl+Shift+S',
    category: 'Screenshot & AI'
  },
  triggerSolution: {
    action: 'triggerSolution',
    key: isMac ? 'Alt+Space' : 'CommandOrControl+Shift+Space',
    category: 'Screenshot & AI'
  },
  appendScreenshot: {
    action: 'appendScreenshot',
    key: `${platformAlt}+Shift+Enter`,
    category: 'Screenshot & AI'
  },
  stopSolutionStream: {
    action: 'stopSolutionStream',
    key: `${platformAlt}+.`,
    category: 'Screenshot & AI'
  },
  copySolutionCode: {
    action: 'copySolutionCode',
    key: `${platformAlt}+Shift+C`,
    category: 'Screenshot & AI'
  },
  deleteLastScreenshot: {
    action: 'deleteLastScreenshot',
    key: isMac ? 'Alt+Backspace' : 'CommandOrControl+Backspace',
    category: 'Screenshot & AI'
  },
  clearScreenshots: {
    action: 'clearScreenshots',
    key: isMac ? 'Alt+Shift+Backspace' : 'CommandOrControl+Shift+Backspace',
    category: 'Screenshot & AI'
  },
  toggleTranscription: {
    action: 'toggleTranscription',
    key: `${platformAlt}+T`,
    category: 'Screenshot & AI'
  },
  clearTranscription: {
    action: 'clearTranscription',
    key: `${platformAlt}+Shift+T`,
    category: 'Screenshot & AI'
  },
  pageUp: { action: 'pageUp', key: 'CommandOrControl+J', category: 'Navigation' },
  pageDown: { action: 'pageDown', key: 'CommandOrControl+K', category: 'Navigation' },
  moveMainWindowUp: {
    action: 'moveMainWindowUp',
    key: 'CommandOrControl+Up',
    category: 'Window Movement'
  },
  moveMainWindowDown: {
    action: 'moveMainWindowDown',
    key: 'CommandOrControl+Down',
    category: 'Window Movement'
  },
  moveMainWindowLeft: {
    action: 'moveMainWindowLeft',
    key: 'CommandOrControl+Left',
    category: 'Window Movement'
  },
  moveMainWindowRight: {
    action: 'moveMainWindowRight',
    key: 'CommandOrControl+Right',
    category: 'Window Movement'
  }
}

export const useShortcutsStore = create<ShortcutsStore>()(
  persist(
    (set) => ({
      shortcuts: Object.fromEntries(
        Object.entries(defaultShortcuts).map(([action, shortcut]) => [
          action,
          { ...shortcut, defaultKey: shortcut.key }
        ])
      ),
      updateShortcut: (action, shortcut) => {
        set((state) => ({
          shortcuts: {
            ...state.shortcuts,
            [action]: shortcut
          }
        }))
      },
      updateShortcuts: (shortcuts) => {
        set({ shortcuts })
      },
      resetShortcuts: () => {
        set({
          shortcuts: Object.fromEntries(
            Object.entries(defaultShortcuts).map(([action, shortcut]) => [
              action,
              { ...shortcut, defaultKey: shortcut.key }
            ])
          )
        })
      }
    }),
    {
      name: 'interview-coder-shortcuts',
      version: 8,
      migrate: (state: unknown, version: number) => {
        if (!isPersistedShortcutsState(state) || !state.shortcuts) return state as ShortcutsStore
        // Rewrite version-specific quirks on the PERSISTED entries first, then
        // merge in current defaults so new actions never hit legacy rewrites
        const persisted = { ...state.shortcuts }

        // v2→v3: On Windows, migrate Alt shortcuts to CommandOrControl (Ctrl)
        if (version < 3 && !isMac) {
          for (const [action, shortcut] of Object.entries(persisted)) {
            persisted[action] = {
              ...shortcut,
              key: shortcut.key.replace(/\bAlt\b/g, 'CommandOrControl'),
              defaultKey: shortcut.defaultKey.replace(/\bAlt\b/g, 'CommandOrControl')
            }
          }
        }

        // v7→v8: deleteLastScreenshot default moved to the platform Alt/
        // Ctrl+Backspace combo; only rewrite when the user never customized it
        if (version < 8) {
          const deleteLast = persisted.deleteLastScreenshot
          const defaultKey = isMac ? 'Alt+Backspace' : 'CommandOrControl+Backspace'
          if (deleteLast && deleteLast.key === deleteLast.defaultKey) {
            persisted.deleteLastScreenshot = {
              ...deleteLast,
              key: defaultKey,
              defaultKey
            }
          }
        }

        const defaults = Object.fromEntries(
          Object.entries(defaultShortcuts).map(([action, shortcut]) => [
            action,
            { ...shortcut, defaultKey: shortcut.key }
          ])
        )
        return {
          ...state,
          shortcuts: {
            ...defaults,
            ...persisted
          }
        } as ShortcutsStore
      }
    }
  )
)
