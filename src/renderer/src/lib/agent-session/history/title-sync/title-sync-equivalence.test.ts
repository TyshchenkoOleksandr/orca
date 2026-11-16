// Temporary equivalence + pass-cost harness (not for merge): old (origin/main) vs new title sync.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '@/store/types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import * as conversations from '../../identity/pane-agent-conversations'
import { startAiVaultTabTitleSync as startNew } from './ai-vault-tab-title-sync'
import { startAiVaultTabTitleSync as startOld } from './old-ai-vault-tab-title-sync'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LEAF_A = '00000000-0000-4000-8000-00000000000a'
const LEAF_B = '00000000-0000-4000-8000-00000000000b'

type Store = ReturnType<typeof buildStore>

function buildStore(count: number, log: string[]) {
  const listeners = new Set<(state: AppState, previous: AppState) => void>()
  const titleVersion = new Map<string, number>()
  let sessionSeq = 0
  let tabSeq = 0
  const live: [string, AgentStatusEntry][] = []
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const layouts: AppState['terminalLayoutsByTabId'] = {}
  const rows: { id: string; repoId: string; hostId: string }[] = []
  const sleeping: AppState['sleepingAgentSessionsByPaneKey'] = {}
  const makeTab = (worktreeId: string): TerminalTab => ({
    id: `tab-${tabSeq++}`,
    worktreeId,
    ptyId: null,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  const statusFor = (tab: TerminalTab, leaf: string): AgentStatusEntry => ({
    paneKey: `${tab.id}:${leaf}`,
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    agentType: sessionSeq % 3 === 0 ? 'claude' : 'codex',
    providerSession: { key: 'session_id', id: `session-${sessionSeq++}` },
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  })
  for (let index = 0; index < count; index++) {
    const worktreeId = `wt-${index}`
    rows.push({ id: worktreeId, repoId: 'fixture', hostId: 'local' })
    const tab = makeTab(worktreeId)
    tabsByWorktree[worktreeId] = [tab]
    const split = index % 4 === 0
    layouts[tab.id] = {
      root: split
        ? {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_A },
            second: { type: 'leaf', leafId: LEAF_B }
          }
        : { type: 'leaf', leafId: LEAF_A },
      activeLeafId: LEAF_A,
      expandedLeafId: null
    } as AppState['terminalLayoutsByTabId'][string]
    if (index % 7 === 3) {
      const entry = statusFor(tab, LEAF_A)
      sleeping[entry.paneKey] = {
        ...entry,
        agent: entry.agentType!,
        capturedAt: 1,
        origin: 'worktree-sleep'
      } as AppState['sleepingAgentSessionsByPaneKey'][string]
    } else {
      live.push([`${tab.id}:${LEAF_A}`, statusFor(tab, LEAF_A)])
      if (split) {
        live.push([`${tab.id}:${LEAF_B}`, statusFor(tab, LEAF_B)])
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- harness supplies the fields the title sync reads.
  let state = {
    agentStatusByPaneKey: acceptedAgentStatuses(live),
    sleepingAgentSessionsByPaneKey: sleeping,
    agentConversationsByPaneKey: {},
    tabsByWorktree,
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: layouts,
    activeWorktreeId: 'wt-0',
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: { fixture: rows },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: {},
    runtimeStatusByEnvironmentId: new Map(),
    setAiVaultTabTitle: (tabId: string, title: TerminalTab['aiVaultTitle'] | null) => {
      const worktreeId = Object.keys(state.tabsByWorktree).find((id) =>
        state.tabsByWorktree[id].some((tab) => tab.id === tabId)
      )
      if (!worktreeId) {
        return
      }
      const current = state.tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)!
      if (JSON.stringify(current.aiVaultTitle ?? null) === JSON.stringify(title ?? null)) {
        return
      }
      log.push(`${Date.now()} write ${tabId} ${JSON.stringify(title)}`)
      set({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) =>
            tab.id === tabId ? { ...tab, aiVaultTitle: title ?? undefined } : tab
          )
        }
      })
    }
  } as unknown as AppState
  const set = (patch: Partial<AppState>): void => {
    const previous = state
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state, previous)
    }
  }
  const commitStatus = (replacements: [string, AgentStatusEntry | null][]): void => {
    const next = state.agentStatusByPaneKey.replace(replacements)
    next.prepare()()
    set({ agentStatusByPaneKey: next })
  }
  return {
    churn(random: () => number): void {
      const keys = [...state.agentStatusByPaneKey.keys()]
      const key = keys[Math.floor(random() * keys.length)]!
      const entry = state.agentStatusByPaneKey.get(key)!
      commitStatus([[key, { ...entry, updatedAt: entry.updatedAt + 1 }]])
      const worktreeId = entry.worktreeId!
      set({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) => ({
            ...tab,
            title: `${tab.title}.`
          }))
        }
      })
    },
    getState: () => state,
    subscribe: (listener: (state: AppState, previous: AppState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resolveSessionTitles: async (args: {
      executionHostScope: string
      requests: { agent: string; sessionId: string; transcriptPath?: string }[]
    }) => {
      log.push(
        `${Date.now()} resolve ${args.executionHostScope} ${args.requests.map((r) => `${r.agent}/${r.sessionId}`).join(',')}`
      )
      return {
        titles: args.requests.map((r) => ({
          agent: r.agent,
          sessionId: r.sessionId,
          title: `${r.sessionId} v${titleVersion.get(r.sessionId) ?? 0}`,
          ...((titleVersion.get(r.sessionId) ?? 0) % 2 ? { kind: 'name' } : {})
        }))
      }
    },
    mutate(random: () => number): string {
      const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)]
      const liveKeys = [...state.agentStatusByPaneKey.keys()]
      const worktreeIds = Object.keys(state.tabsByWorktree)
      const kind = Math.floor(random() * 12)
      switch (kind) {
        case 0: {
          const key = pick(liveKeys)
          const entry = key ? state.agentStatusByPaneKey.get(key) : undefined
          if (entry) {
            commitStatus([[key!, { ...entry, updatedAt: entry.updatedAt + 1 }]])
          }
          return 'ping'
        }
        case 1: {
          const key = pick(liveKeys)
          const entry = key ? state.agentStatusByPaneKey.get(key) : undefined
          if (entry) {
            commitStatus([
              [
                key!,
                { ...entry, providerSession: { key: 'session_id', id: `session-${sessionSeq++}` } }
              ]
            ])
          }
          return 'session'
        }
        case 2: {
          const worktreeId = pick(worktreeIds)!
          set({
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) => ({
                ...tab,
                title: `${tab.title}.`
              }))
            }
          })
          return 'tab-title'
        }
        case 3: {
          const key = pick(liveKeys)
          const id = key ? state.agentStatusByPaneKey.get(key)?.providerSession?.id : undefined
          if (id) {
            titleVersion.set(id, (titleVersion.get(id) ?? 0) + 1)
          }
          return 'transcript-title'
        }
        case 4: {
          const tabId = pick(Object.keys(state.terminalLayoutsByTabId))!
          const layout = state.terminalLayoutsByTabId[tabId]!
          set({
            terminalLayoutsByTabId: {
              ...state.terminalLayoutsByTabId,
              [tabId]: { ...layout, activeLeafId: layout.activeLeafId === LEAF_A ? LEAF_B : LEAF_A }
            }
          })
          return 'active-leaf'
        }
        case 5: {
          const worktreeId = pick(worktreeIds)!
          const tab = makeTab(worktreeId)
          const entry = statusFor(tab, LEAF_A)
          const next = state.agentStatusByPaneKey.replace([[entry.paneKey, entry]])
          next.prepare()()
          set({
            agentStatusByPaneKey: next,
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [worktreeId]: [...state.tabsByWorktree[worktreeId], tab]
            },
            terminalLayoutsByTabId: {
              ...state.terminalLayoutsByTabId,
              [tab.id]: {
                root: { type: 'leaf', leafId: LEAF_A },
                activeLeafId: LEAF_A,
                expandedLeafId: null
              } as AppState['terminalLayoutsByTabId'][string]
            }
          })
          return 'add-tab'
        }
        case 6: {
          const worktreeId = pick(worktreeIds)!
          const tabs = state.tabsByWorktree[worktreeId]
          const tab = pick(tabs)
          if (tab) {
            set({
              tabsByWorktree: {
                ...state.tabsByWorktree,
                [worktreeId]: tabs.filter((t) => t !== tab)
              }
            })
          }
          return 'remove-tab'
        }
        case 7: {
          const key = pick(liveKeys)
          const entry = key ? state.agentStatusByPaneKey.get(key) : undefined
          if (entry?.providerSession && entry.agentType) {
            const next = state.agentStatusByPaneKey.replace([[key!, null]])
            next.prepare()()
            set({
              agentStatusByPaneKey: next,
              sleepingAgentSessionsByPaneKey: {
                ...state.sleepingAgentSessionsByPaneKey,
                [key!]: {
                  ...entry,
                  agent: entry.agentType,
                  capturedAt: 1,
                  origin: 'worktree-sleep'
                } as AppState['sleepingAgentSessionsByPaneKey'][string]
              }
            })
          }
          return 'sleep'
        }
        case 8:
          set({ activeWorktreeId: pick(worktreeIds)! })
          return 'active-worktree'
        case 9: {
          const worktreeId = pick(worktreeIds)!
          const tab = pick(state.tabsByWorktree[worktreeId])
          if (tab) {
            const paneKey = `${tab.id}:${LEAF_B}`
            set({
              agentConversationsByPaneKey: {
                ...state.agentConversationsByPaneKey,
                [paneKey]: {
                  paneKey,
                  worktreeId,
                  executionHostId: 'local',
                  connectionId: null,
                  agent: 'codex',
                  providerSession: { key: 'session_id', id: `session-${sessionSeq++}` }
                } as AppState['agentConversationsByPaneKey'][string]
              }
            })
          }
          return 'conversation'
        }
        case 10: {
          const key = pick(liveKeys)
          const entry = key ? state.agentStatusByPaneKey.get(key) : undefined
          if (entry) {
            commitStatus([
              [key!, null],
              [key!, entry]
            ])
          }
          return 'move-key'
        }
        default: {
          const worktreeId = pick(worktreeIds)!
          set({
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) =>
                tab.sessionTitleFromHost
                  ? { ...tab, sessionTitleFromHost: undefined }
                  : { ...tab, sessionTitleFromHost: true as const }
              )
            }
          })
          return 'host-named'
        }
      }
    }
  }
}

function start(which: 'old' | 'new', store: Store): () => void {
  const begin = which === 'old' ? startOld : startNew
  return begin({
    getState: store.getState,
    subscribe: store.subscribe,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- harness resolver.
    resolveSessionTitles: store.resolveSessionTitles as never,
    scheduleReconcile: (callback) => {
      const timer = setTimeout(callback, 1_000)
      return () => clearTimeout(timer)
    }
  })
}

async function runScript(which: 'old' | 'new', seed: number, count: number, steps: number) {
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  const log: string[] = []
  const store = buildStore(count, log)
  const random = rng(seed)
  const stop = start(which, store)
  await vi.advanceTimersByTimeAsync(2_000)
  for (let step = 0; step < steps; step++) {
    const kind = store.mutate(random)
    log.push(`${Date.now()} step ${step} ${kind}`)
    await vi.advanceTimersByTimeAsync(Math.floor(random() * 25_000))
  }
  await vi.advanceTimersByTimeAsync(60_000)
  stop()
  vi.useRealTimers()
  return log
}

describe('title sync old vs new', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
    'seed %i sends the same requests and writes the same titles',
    async (seed) => {
      const old = await runScript('old', seed, 12, 120)
      const next = await runScript('new', seed, 12, 120)
      expect(next.filter((l) => !l.includes(' step ')).length).toBeGreaterThan(0)
      expect(next).toEqual(old)
    }
  )

  it.each([100, 1000])('pass cost at %i workspaces', async (count) => {
    const report: string[] = []
    for (const scenario of ['idle', 'churn'] as const) {
      for (const which of ['old', 'new'] as const) {
        vi.useFakeTimers({ now: 1_700_000_000_000 })
        const log: string[] = []
        const store = buildStore(count, log)
        const collect = vi.spyOn(conversations, 'collectAgentPaneConversations')
        const stop = start(which, store)
        await vi.advanceTimersByTimeAsync(30_000)
        const durations: number[] = []
        const random = rng(7)
        collect.mockClear()
        for (let pass = 0; pass < 30; pass++) {
          if (scenario === 'churn') {
            // Non-title churn between passes: status pings and tab title updates.
            for (let i = 0; i < 20; i++) {
              store.churn(random)
            }
          }
          const t0 = performance.now()
          await vi.advanceTimersByTimeAsync(20_000)
          durations.push(performance.now() - t0)
        }
        stop()
        vi.useRealTimers()
        const sorted = durations.toSorted((a, b) => a - b)
        report.push(
          `${count} ${scenario} ${which}: p50 ${sorted[14].toFixed(2)} p95 ${sorted[28].toFixed(2)} max ${sorted[29].toFixed(2)} ms; collects/pass ${(collect.mock.calls.length / 30).toFixed(1)}`
        )
        collect.mockRestore()
      }
    }
    console.log(report.join('\n'))
  })
})
