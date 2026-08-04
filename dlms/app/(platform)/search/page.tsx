import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { globalSearch } from '@/modules/shared/search/services/searchService'
import { visibleSearchGroups } from '@/modules/shared/search/domain/searchGroups'
import { MIN_QUERY_LENGTH } from '@/modules/shared/search/domain/searchQuery'

type PageProps = { searchParams: { q?: string } }

/**
 * The full-page results view behind the ⌘K palette (spec §8.4).
 *
 * NOT permission-gated with `notFound()`, unlike /approvals: search is available
 * to every signed-in user, and what varies is WHICH GROUPS they get. An actor with
 * no searchable groups at all sees the "nothing enabled" message rather than a
 * 404, because the section genuinely exists for them — it is simply empty, and
 * that is not a disclosure since it reveals nothing about any particular module.
 *
 * Both this page and the palette call the SAME `globalSearch`, so a link shared
 * between two people shows each of them only what they may see.
 */
export default async function SearchPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  const q = (searchParams.q ?? '').trim()

  const groupCount = visibleSearchGroups(actor).length
  const result = q.length >= MIN_QUERY_LENGTH
    ? await globalSearch(actor, { q })
    : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Search</h1>
        <p className="mt-1 text-slate-600">
          Devices, components, refs, invoices, delivery orders, tasks and people —
          across every section you can enter. Press{' '}
          <kbd className="rounded border bg-slate-50 px-1.5 py-0.5 text-xs">⌘K</kbd>{' '}
          anywhere.
        </p>
      </div>

      <form action="/search" className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search…"
          aria-label="Search"
          className="w-full max-w-lg rounded-md border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
        >
          Search
        </button>
      </form>

      {groupCount === 0 && (
        <p className="text-sm text-slate-500">
          No searchable sections are enabled for your account yet. Contact your Super Admin.
        </p>
      )}

      {groupCount > 0 && q.length > 0 && q.length < MIN_QUERY_LENGTH && (
        <p className="text-sm text-slate-500">
          Enter at least {MIN_QUERY_LENGTH} characters.
        </p>
      )}

      {result && result.groups.length === 0 && (
        <p className="text-sm text-slate-500">Nothing matches “{q}”.</p>
      )}

      {result?.groups.map((g) => (
        <section key={g.key}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {g.label}
          </h2>
          <ul className="mt-2 divide-y rounded-md border">
            {g.hits.map((h) => (
              <li key={h.id}>
                {h.href ? (
                  <Link
                    href={h.href}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                  >
                    <span className="truncate font-medium">{h.label}</span>
                    {h.sublabel && (
                      <span className="shrink-0 text-xs text-slate-500">{h.sublabel}</span>
                    )}
                  </Link>
                ) : (
                  // Unrouted groups (components, people) still earn a row: the hit
                  // confirms the record exists and shows its context. A link here
                  // would 404, which reads as "deleted" rather than "no page".
                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-slate-600">
                    <span className="truncate font-medium">{h.label}</span>
                    {h.sublabel && (
                      <span className="shrink-0 text-xs text-slate-500">{h.sublabel}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
