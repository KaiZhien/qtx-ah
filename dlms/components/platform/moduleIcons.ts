import {
  Wrench, Banknote, Truck, Factory, Hammer, CheckSquare, Settings, LayoutGrid,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Single source of truth for MODULE_REGISTRY icon names -> lucide components.
// Keep in sync with MODULE_REGISTRY (modules/shared/navigation/moduleRegistry.ts);
// a name missing here fails safe to LayoutGrid via iconFor() instead of
// crashing whichever surface renders it.
export const MODULE_ICONS: Record<string, LucideIcon> = {
  Wrench, Banknote, Truck, Factory, Hammer, CheckSquare, Settings,
}

export function iconFor(name: string): LucideIcon {
  return MODULE_ICONS[name] ?? LayoutGrid
}
