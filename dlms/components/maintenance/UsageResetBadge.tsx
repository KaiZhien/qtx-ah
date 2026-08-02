import { Badge } from '@/components/ui/badge'

/**
 * The "counter reset detected" marker (spec §6.3).
 *
 * The label text carries the whole meaning — colour is reinforcement only, per
 * spec §8.1 ("no colour-only status signaling"). It is a WARNING, not an error:
 * a reset reading is a valid, accepted observation, and the badge exists so a
 * lower number is never mistaken for a data-entry mistake.
 */
export function UsageResetBadge() {
  return <Badge variant="warning">Counter reset</Badge>
}
