import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Filler,
} from 'chart.js'
import type { EquityPoint } from '@/types'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler)

interface Props {
  equity: EquityPoint[]
  height?: number
}

export function EquityChart({ equity, height = 180 }: Props) {
  const labels = equity.map((p) => {
    const d = new Date(p.time * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const values = equity.map((p) => p.value)
  const isPositive = (values.at(-1) ?? 100) >= 100

  return (
    <div style={{ height }}>
      <Line
        height={height}
        data={{
          labels,
          datasets: [{
            data: values,
            borderColor: isPositive ? '#15a349' : '#dc2626',
            backgroundColor: isPositive ? 'rgba(21,163,73,0.08)' : 'rgba(220,38,38,0.08)',
            borderWidth: 1.5,
            fill: true,
            pointRadius: 0,
            tension: 0.3,
          }],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
          scales: {
            x: { display: false },
            y: {
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: { font: { size: 10 }, color: '#6b7280' },
            },
          },
        }}
      />
    </div>
  )
}
