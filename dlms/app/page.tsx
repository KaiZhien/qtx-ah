import { redirect } from 'next/navigation'

// Temporary: the platform home replaces this in Task 7. Until then, the root
// sends visitors to the relocated DLMS app so nothing 404s mid-migration.
export default function RootRedirect() {
  redirect('/legacy')
}
