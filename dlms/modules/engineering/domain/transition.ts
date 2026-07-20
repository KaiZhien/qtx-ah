/**
 * Shared, pure transition primitive for the Engineering module (ECR, ECO,
 * firmware release). Mirrors the manufacturing deviceStatus.ts discipline:
 * forbidden moves are decided HERE — before any DB write — with no I/O.
 *
 * The graph is a plain adjacency map: each status maps to the statuses it may
 * move to. A status whose edge list is empty is terminal.
 *
 * Fail-closed by construction: an unknown source status is absent from the map,
 * so canTransition returns false for every move out of it. Unlike the
 * manufacturing status graph (an admin-editable status_transition TABLE), these
 * three flows are fixed CHECK vocabularies, so the graph lives in code and is
 * unit-tested directly.
 */
export type TransitionGraph = Readonly<Record<string, readonly string[]>>

/** True iff `from → to` is an edge in the graph. Unknown from/to → false. */
export function canTransition(graph: TransitionGraph, from: string, to: string): boolean {
  const edges = graph[from]
  if (!edges) return false // fail-closed: unknown source has no outgoing edges
  return edges.includes(to)
}

/** The legal onward statuses from `from`; [] for a terminal or unknown state. */
export function nextStates(graph: TransitionGraph, from: string): readonly string[] {
  return graph[from] ?? []
}

/** A KNOWN state with no outgoing edges. Unknown states are not terminal. */
export function isTerminal(graph: TransitionGraph, status: string): boolean {
  const edges = graph[status]
  return edges !== undefined && edges.length === 0
}

/** Whether `status` is a defined node in the graph. */
export function isKnownState(graph: TransitionGraph, status: string): boolean {
  return status in graph
}

/**
 * Thrown by the write services when a requested status change is not a legal
 * edge. Carries structured fields so the action layer can surface a friendly,
 * entity-specific message without string-matching (see the toMessage contract
 * in the engineering actions).
 */
export class InvalidTransitionError extends Error {
  readonly entity: string
  readonly from: string
  readonly to: string
  constructor(entity: string, from: string, to: string) {
    super(`Cannot move this ${entity} from "${from}" to "${to}".`)
    this.name = 'InvalidTransitionError'
    this.entity = entity
    this.from = from
    this.to = to
  }
}
