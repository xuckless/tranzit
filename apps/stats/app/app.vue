<script setup>
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js'
import { Line } from 'vue-chartjs'
import { ref, onMounted, onUnmounted, computed } from 'vue'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

const dockerStats = ref([])
const tailscalePeers = ref([])
const timeLabels = ref([])
const cpuHistory = ref({})
const memHistory = ref({})
const MAX_HISTORY = 30

let dockerInterval = null
let tailscaleInterval = null

const fetchDockerStats = async () => {
  try {
    const res = await $fetch(`/api/docker?t=${Date.now()}`)
    if (res.status === 'success') {
      dockerStats.value = res.data
      
      const now = new Date().toLocaleTimeString()
      
      // Immutable update for timeLabels
      const newTimeLabels = [...timeLabels.value, now]
      if (newTimeLabels.length > MAX_HISTORY) newTimeLabels.shift()
      timeLabels.value = newTimeLabels

      const newCpuHistory = { ...cpuHistory.value }
      const newMemHistory = { ...memHistory.value }

      res.data.forEach(container => {
        const name = container.Name
        const cpuStr = container.CPUPerc.replace('%', '')
        const cpuVal = parseFloat(cpuStr) || 0
        
        const memStr = container.MemPerc.replace('%', '')
        const memVal = parseFloat(memStr) || 0

        if (!newCpuHistory[name]) newCpuHistory[name] = []
        if (!newMemHistory[name]) newMemHistory[name] = []

        const updatedCpuArray = [...newCpuHistory[name], cpuVal]
        if (updatedCpuArray.length > MAX_HISTORY) updatedCpuArray.shift()
        newCpuHistory[name] = updatedCpuArray

        const updatedMemArray = [...newMemHistory[name], memVal]
        if (updatedMemArray.length > MAX_HISTORY) updatedMemArray.shift()
        newMemHistory[name] = updatedMemArray
      })

      cpuHistory.value = newCpuHistory
      memHistory.value = newMemHistory
    }
  } catch (error) {
    console.error('Failed to fetch docker stats', error)
  }
}

const fetchTailscaleStats = async () => {
  try {
    const res = await $fetch(`/api/tailscale?t=${Date.now()}`)
    if (res.status === 'success') {
      tailscalePeers.value = res.data
    }
  } catch (error) {
    console.error('Failed to fetch tailscale stats', error)
  }
}

onMounted(() => {
  fetchDockerStats()
  fetchTailscaleStats()
  
  dockerInterval = setInterval(fetchDockerStats, 2000)
  tailscaleInterval = setInterval(fetchTailscaleStats, 5000)
})

onUnmounted(() => {
  if (dockerInterval) clearInterval(dockerInterval)
  if (tailscaleInterval) clearInterval(tailscaleInterval)
})

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      labels: {
        color: '#e5e7eb'
      }
    }
  },
  scales: {
    x: {
      ticks: { color: '#9ca3af' },
      grid: { color: '#374151' }
    },
    y: {
      ticks: { color: '#9ca3af' },
      grid: { color: '#374151' }
    }
  }
}

// Generate distinct colors for lines
const colors = [
  '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e'
]

const cpuChartData = computed(() => {
  const datasets = Object.keys(cpuHistory.value).map((name, index) => ({
    label: name,
    data: cpuHistory.value[name],
    borderColor: colors[index % colors.length],
    tension: 0.4,
    borderWidth: 2,
    pointRadius: 0
  }))

  return {
    labels: timeLabels.value,
    datasets
  }
})

const memChartData = computed(() => {
  const datasets = Object.keys(memHistory.value).map((name, index) => ({
    label: name,
    data: memHistory.value[name],
    borderColor: colors[index % colors.length],
    tension: 0.4,
    borderWidth: 2,
    pointRadius: 0
  }))

  return {
    labels: timeLabels.value,
    datasets
  }
})

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// --- Docker table sorting (shared across the app + sidecar tables) ---
const sortKey = ref('name')
const sortDir = ref('asc')

const setSort = (key) => {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

// Parse a docker size token (e.g. "124.3MiB", "1.2kB", "3.4GB") into bytes for sorting.
const parseSize = (token) => {
  if (!token) return 0
  const m = String(token).trim().match(/([\d.]+)\s*([a-zA-Z]*)/)
  if (!m) return 0
  const val = parseFloat(m[1]) || 0
  const units = {
    '': 1, b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }
  return val * (units[m[2].toLowerCase()] ?? 1)
}

const sortValue = (c, key) => {
  switch (key) {
    case 'cpu': return parseFloat(c.CPUPerc) || 0
    case 'mem': return parseSize((c.MemUsage || '').split('/')[0])
    case 'net': return parseSize((c.NetIO || '').split('/')[0])
    case 'pids': return parseInt(c.PIDs) || 0
    default: return (c.Name || '').toLowerCase()
  }
}

const sortContainers = (list) =>
  [...list].sort((a, b) => {
    const va = sortValue(a, sortKey.value)
    const vb = sortValue(b, sortKey.value)
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb
    return sortDir.value === 'asc' ? cmp : -cmp
  })

// Tailscale sidecars (`*-ts`) are infra noise next to the app containers — split them out.
const isSidecar = (c) => (c.Name || '').endsWith('-ts')
const appContainers = computed(() => sortContainers(dockerStats.value.filter((c) => !isSidecar(c))))
const sidecarContainers = computed(() => sortContainers(dockerStats.value.filter(isSidecar)))
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-gray-100 p-6 font-sans">
    <div class="max-w-7xl mx-auto space-y-8">
      
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-bold text-white tracking-tight">Tranzit Stats</h1>
          <p class="text-gray-400 mt-1">Live monitoring for Tranzit containers and network</p>
        </div>
        <div class="flex items-center space-x-2">
          <span class="relative flex h-3 w-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          <span class="text-sm font-medium text-emerald-500">Live</span>
        </div>
      </header>

      <!-- Service Health: the primary at-a-glance signal -->
      <section class="space-y-3">
        <HealthPanel />
      </section>

      <!-- Resource Usage -->
      <section class="space-y-3">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-500">Resource Usage</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="bg-gray-800 rounded-xl border border-gray-700 p-5 shadow-sm">
            <h3 class="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full bg-blue-400"></span>
              CPU Usage <span class="text-gray-500 font-normal">(%)</span>
            </h3>
            <div class="h-64">
              <Line v-if="timeLabels.length > 0" :data="cpuChartData" :options="chartOptions" />
              <div v-else class="h-full flex items-center justify-center text-gray-500">Waiting for data...</div>
            </div>
          </div>

          <div class="bg-gray-800 rounded-xl border border-gray-700 p-5 shadow-sm">
            <h3 class="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full bg-purple-400"></span>
              Memory Usage <span class="text-gray-500 font-normal">(%)</span>
            </h3>
            <div class="h-64">
              <Line v-if="timeLabels.length > 0" :data="memChartData" :options="chartOptions" />
              <div v-else class="h-full flex items-center justify-center text-gray-500">Waiting for data...</div>
            </div>
          </div>
        </div>
      </section>

      <!-- Docker Containers (app services) -->
      <section class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-500">Docker Containers</h2>
          <span class="text-xs text-gray-600">click a column to sort</span>
        </div>
        <DockerTable
          :containers="appContainers"
          :sort-key="sortKey"
          :sort-dir="sortDir"
          empty-text="No Tranzit containers found"
          @sort="setSort"
        />
      </section>

      <!-- Tailscale Sidecars (-ts containers) -->
      <section class="space-y-3">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Tailscale Sidecars <span class="text-gray-600 normal-case font-normal tracking-normal">(-ts containers)</span>
        </h2>
        <DockerTable
          :containers="sidecarContainers"
          :sort-key="sortKey"
          :sort-dir="sortDir"
          empty-text="No sidecar containers found"
          @sort="setSort"
        />
      </section>

      <!-- Tailscale Network -->
      <section class="space-y-3">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-500">Tailscale Network</h2>
        <div class="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden shadow-sm">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm whitespace-nowrap">
              <thead class="uppercase tracking-wider text-xs text-gray-500 bg-gray-900/40">
                <tr>
                  <th scope="col" class="px-6 py-3 font-medium">Hostname</th>
                  <th scope="col" class="px-6 py-3 font-medium">IPs</th>
                  <th scope="col" class="px-6 py-3 font-medium">OS</th>
                  <th scope="col" class="px-6 py-3 font-medium">Status</th>
                  <th scope="col" class="px-6 py-3 font-medium">Traffic (Tx / Rx)</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-700/60">
                <tr v-for="peer in tailscalePeers" :key="peer.ID" class="hover:bg-gray-700/40 transition-colors">
                  <td class="px-6 py-3.5 font-medium text-gray-200">
                    {{ peer.HostName }}
                    <span v-if="peer.HostName === 'fedora'" class="ml-2 text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">Self</span>
                  </td>
                  <td class="px-6 py-3.5 font-mono text-xs text-gray-400">
                    <div v-for="ip in peer.TailscaleIPs" :key="ip">{{ ip }}</div>
                  </td>
                  <td class="px-6 py-3.5 capitalize text-gray-300">{{ peer.OS || 'Unknown' }}</td>
                  <td class="px-6 py-3.5">
                    <span v-if="peer.Online" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-400/10 text-emerald-400">
                      Online
                    </span>
                    <span v-else class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-400/10 text-red-400">
                      Offline
                    </span>
                  </td>
                  <td class="px-6 py-3.5 font-mono text-xs text-gray-400">
                    <span class="text-blue-400">{{ formatBytes(peer.TxBytes) }}</span> /
                    <span class="text-purple-400">{{ formatBytes(peer.RxBytes) }}</span>
                  </td>
                </tr>
                <tr v-if="tailscalePeers.length === 0">
                  <td colspan="5" class="px-6 py-8 text-center text-gray-500">No Tranzit tailscale peers found</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>