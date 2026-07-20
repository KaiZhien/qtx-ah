// __tests__/engineering/transition.test.ts
import { describe, it, expect } from 'vitest'
import {
  canTransition, nextStates, isTerminal, isKnownState, InvalidTransitionError,
  type TransitionGraph,
} from '@/modules/engineering/domain/transition'

const GRAPH: TransitionGraph = {
  a: ['b'],
  b: ['c', 'd'],
  c: [],
  d: [],
}

describe('canTransition', () => {
  it('permits an edge that exists', () => {
    expect(canTransition(GRAPH, 'a', 'b')).toBe(true)
    expect(canTransition(GRAPH, 'b', 'c')).toBe(true)
  })

  it('rejects an edge that does not exist between known states', () => {
    expect(canTransition(GRAPH, 'a', 'c')).toBe(false)
  })

  it('fails closed for an unknown source state', () => {
    expect(canTransition(GRAPH, 'zzz', 'b')).toBe(false)
  })

  it('fails closed for an unknown target state', () => {
    expect(canTransition(GRAPH, 'a', 'zzz')).toBe(false)
  })

  it('rejects a move out of a terminal state', () => {
    expect(canTransition(GRAPH, 'c', 'a')).toBe(false)
  })
})

describe('nextStates', () => {
  it('lists the outgoing edges of a known state', () => {
    expect(nextStates(GRAPH, 'b')).toEqual(['c', 'd'])
  })
  it('returns [] for a terminal state', () => {
    expect(nextStates(GRAPH, 'c')).toEqual([])
  })
  it('returns [] (never throws) for an unknown state', () => {
    expect(nextStates(GRAPH, 'nope')).toEqual([])
  })
})

describe('isTerminal', () => {
  it('is true for a state with no outgoing edges', () => {
    expect(isTerminal(GRAPH, 'c')).toBe(true)
  })
  it('is false for a state with outgoing edges', () => {
    expect(isTerminal(GRAPH, 'a')).toBe(false)
  })
  it('is false (not terminal) for an unknown state — unknown ≠ dead-end', () => {
    expect(isTerminal(GRAPH, 'nope')).toBe(false)
  })
})

describe('isKnownState', () => {
  it('distinguishes known from unknown', () => {
    expect(isKnownState(GRAPH, 'a')).toBe(true)
    expect(isKnownState(GRAPH, 'nope')).toBe(false)
  })
})

describe('InvalidTransitionError', () => {
  it('carries entity/from/to and reads as an Error', () => {
    const e = new InvalidTransitionError('ECR', 'accepted', 'draft')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('InvalidTransitionError')
    expect(e.entity).toBe('ECR')
    expect(e.from).toBe('accepted')
    expect(e.to).toBe('draft')
    expect(e.message).toContain('accepted')
    expect(e.message).toContain('draft')
  })
})
