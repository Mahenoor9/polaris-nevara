import { Card, CardContent } from '@/components/ui/card'
import { LucideIcon } from 'lucide-react'

interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  gradient?: boolean
  className?: string
}

export default function StatsCard({
  title,
  value,
  icon: Icon,
  gradient = false,
  className = ''
}: StatsCardProps) {
  return (
    <Card
      className={`hover-elevate transition-all ${
        gradient ? 'bg-gradient-to-br from-primary/10 to-primary/5' : ''
      } ${className}`}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-muted-foreground mb-2">
              {title}
            </p>

            <p
              className="text-3xl font-bold font-heading"
              data-testid={`text-${title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {value}
            </p>
          </div>

          <div className="p-3 rounded-full bg-primary/10">
            <Icon className="w-6 h-6 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
