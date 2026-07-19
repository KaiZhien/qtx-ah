import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function UnauthorizedPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
      <h1 className="text-2xl font-bold">Access Denied</h1>
      <p className="text-muted-foreground">You do not have permission to view this page.</p>
      <Link href="/legacy"><Button variant="outline">Back to Dashboard</Button></Link>
    </div>
  )
}
