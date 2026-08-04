'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { searchAction } from '@/app/(platform)/search/actions'
import { MIN_QUERY_LENGTH } from '@/modules/shared/search/domain/searchQuery'
import type { SearchGroupResult } from '@/modules/shared/search/services/searchService'
import { cn } from '@/lib/utils'

/** Wait after the last keystroke before asking the server (spec §8.4 cost note). */
const DEBOUNCE_MS = 200

type FlatHit = {
  groupLabel: string
  id: string
  label: string
  sublabel: string | null
  href: string | null
  /** Index within the flattened list, for keyboard navigation. */
  index: number
}

/**
 * The ⌘K command palette + header field (spec §8.4).
 *
 * KEYBOARD-NAVIGABLE, per the spec: ↑/↓ move through the FLATTENED hit list so a
 * single Enter always opens whatever is highlighted, regardless of grouping.
 * Escape closes. Groups are headings only; they are never focus stops, because a
 * user holding ↓ should not have to skip past them.
 *
 * The palette renders only the groups the SERVER returned. It never receives, and
 * so cannot leak, the existence of a group the actor may not search — the filter
 * is `visibleSearchGroups` on the server, not a `hidden` class here.
 */
export function SearchPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroupResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Guards against an out-of-order response overwriting a newer one: a slow
  // query for "QT" must not replace the results for "QTX-P-004".
  const requestSeq = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setGroups([])
      setError(null)
      setLoading(false)
      return
    }

    const seq = ++requestSeq.current
    setLoading(true)
    // THE CALLBACK IS ASYNC, SO IT MUST CATCH ITS OWN REJECTION. `setTimeout` has
    // nowhere to put a rejected promise: an expired session, a dropped connection
    // or a server-action transport error would surface as an unhandled rejection
    // in the console while the palette sat on "Searching…" forever. This is the
    // same uncaught-async-in-a-callback shape already carried against
    // DeviceTable's "Load more".
    const timer = setTimeout(async () => {
      try {
        const res = await searchAction(query)
        if (seq !== requestSeq.current) return // a newer keystroke already won
        setLoading(false)
        if (res.ok) {
          setGroups(res.result.groups)
          setError(null)
        } else {
          setGroups([])
          setError(res.error)
        }
        setActive(0)
      } catch {
        // A stale response's failure must not overwrite a newer query's results,
        // exactly as its success would not.
        if (seq !== requestSeq.current) return
        setLoading(false)
        setGroups([])
        setError('Search is unavailable right now. Try again in a moment.')
        setActive(0)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, open])

  const flat = useMemo<FlatHit[]>(() => {
    let i = 0
    return groups.flatMap((g) =>
      g.hits.map((h) => ({
        groupLabel: g.label, id: h.id, label: h.label,
        sublabel: h.sublabel, href: h.href, index: i++,
      })))
  }, [groups])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setGroups([])
    setError(null)
    setActive(0)
  }, [])

  const go = useCallback((hit: FlatHit | undefined) => {
    if (!hit?.href) return   // unrouted groups are informational, not clickable
    close()
    router.push(hit.href)
  }, [close, router])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (flat.length === 0 ? 0 : (a + 1) % flat.length))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (flat.length === 0 ? 0 : (a - 1 + flat.length) % flat.length))
    }
    if (e.key === 'Enter') { e.preventDefault(); go(flat[active]) }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        <span>Search</span>
        <kbd className="ml-2 rounded border bg-slate-50 px-1.5 py-0.5 text-xs text-slate-400">⌘K</kbd>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 pt-24"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search devices, refs, invoices, people…"
            aria-label="Global search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            className="w-full py-3 text-sm outline-none placeholder:text-slate-400"
          />
        </div>

        <div id="search-results" className="max-h-96 overflow-y-auto" role="listbox">
          {error && <p className="px-4 py-6 text-sm text-red-700">{error}</p>}

          {!error && query.trim().length < MIN_QUERY_LENGTH && (
            <p className="px-4 py-6 text-sm text-slate-500">
              Type at least {MIN_QUERY_LENGTH} characters.
            </p>
          )}

          {!error && query.trim().length >= MIN_QUERY_LENGTH && loading && (
            <p className="px-4 py-6 text-sm text-slate-500">Searching…</p>
          )}

          {!error && !loading && query.trim().length >= MIN_QUERY_LENGTH
            && flat.length === 0 && (
            <p className="px-4 py-6 text-sm text-slate-500">
              Nothing matches “{query}”.
            </p>
          )}

          {!loading && groups.map((g) => (
            <div key={g.key}>
              <p className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {g.label}
              </p>
              <ul>
                {g.hits.map((h) => {
                  const item = flat.find((f) => f.id === h.id && f.groupLabel === g.label)
                  const isActive = item?.index === active
                  return (
                    <li key={`${g.key}:${h.id}`} role="option" aria-selected={isActive}>
                      <button
                        type="button"
                        disabled={!h.href}
                        onMouseEnter={() => item && setActive(item.index)}
                        onClick={() => go(item)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm',
                          isActive && 'bg-slate-100',
                          !h.href && 'cursor-default text-slate-500',
                        )}
                      >
                        <span className="truncate font-medium">{h.label}</span>
                        {h.sublabel && (
                          <span className="shrink-0 truncate text-xs text-slate-500">
                            {h.sublabel}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t bg-slate-50 px-4 py-2 text-xs text-slate-500">
          <span>↑↓ to navigate</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  )
}
