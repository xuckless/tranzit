<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const results = ref([])
const checkedAt = ref(null)
const loading = ref(false)
// container name -> true while a restart is in flight
const restarting = ref({})

let pollInterval = null
const POLL_MS = 10000

const fetchHealth = async () => {
  loading.value = true
  try {
    const res = await $fetch(`/api/health?t=${Date.now()}`)
    if (res.status === 'success') {
      results.value = res.data
      checkedAt.value = res.checkedAt
    }
  } catch (error) {
    console.error('Failed to fetch health', error)
  } finally {
    loading.value = false
  }
}

const restartService = async (container) => {
  if (!container || restarting.value[container]) return
  if (!window.confirm(`Restart ${container}?\n\nThis runs "docker restart ${container}" to re-attach it to its Tailscale sidecar.`)) {
    return
  }
  restarting.value = { ...restarting.value, [container]: true }
  try {
    const res = await $fetch('/api/restart', {
      method: 'POST',
      body: { container },
    })
    if (res.status !== 'success') {
      window.alert(`Restart failed: ${res.message}`)
    }
  } catch (error) {
    window.alert(`Restart failed: ${error?.data?.message || error.message}`)
  } finally {
    restarting.value = { ...restarting.value, [container]: false }
    // Give the container a moment to come back, then re-check.
    setTimeout(fetchHealth, 1500)
  }
}

const healAll = async () => {
  const down = results.value.filter((r) => !r.healthy).map((r) => r.container)
  if (down.length === 0) return
  if (!window.confirm(`Restart ${down.length} unhealthy service(s)?\n\n${down.join('\n')}`)) {
    return
  }
  for (const container of down) {
    restarting.value = { ...restarting.value, [container]: true }
    try {
      await $fetch('/api/restart', { method: 'POST', body: { container } })
    } catch (error) {
      console.error(`Heal-all failed for ${container}`, error)
    } finally {
      restarting.value = { ...restarting.value, [container]: false }
    }
  }
  setTimeout(fetchHealth, 1500)
}

onMounted(() => {
  fetchHealth()
  pollInterval = setInterval(fetchHealth, POLL_MS)
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})

const healthyCount = computed(() => results.value.filter((r) => r.healthy).length)
const total = computed(() => results.value.length)
const allHealthy = computed(() => total.value > 0 && healthyCount.value === total.value)
const anyDown = computed(() => results.value.some((r) => !r.healthy))

const summaryColor = computed(() => {
  if (total.value === 0) return 'text-gray-400'
  if (allHealthy.value) return 'text-emerald-400'
  if (healthyCount.value === 0) return 'text-red-400'
  return 'text-amber-400'
})

const lastChecked = computed(() =>
  checkedAt.value ? new Date(checkedAt.value).toLocaleTimeString() : '—',
)
</script>

<template>
  <div class="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden shadow-sm">
    <!-- Header -->
    <div class="px-6 py-4 border-b border-gray-700 bg-gray-800/50 flex items-center justify-between flex-wrap gap-3">
      <div class="flex items-center gap-3">
        <h2 class="text-lg font-semibold text-white">Service Health</h2>
        <span :class="summaryColor" class="text-sm font-medium tabular-nums">
          {{ healthyCount }} / {{ total }} healthy
        </span>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs text-gray-500">Checked {{ lastChecked }}</span>
        <button
          @click="fetchHealth"
          :disabled="loading"
          class="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-50"
        >
          {{ loading ? 'Checking…' : 'Refresh' }}
        </button>
        <button
          @click="healAll"
          :disabled="!anyDown"
          class="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          :class="anyDown ? 'bg-amber-500 hover:bg-amber-400 text-gray-900' : 'bg-gray-700 text-gray-400'"
        >
          Heal all unhealthy
        </button>
      </div>
    </div>

    <!-- Service grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-gray-700">
      <div
        v-for="svc in results"
        :key="svc.key"
        class="bg-gray-800 p-4 flex items-center justify-between gap-3"
      >
        <div class="flex items-center gap-3 min-w-0">
          <!-- Status dot -->
          <span class="relative flex h-3 w-3 shrink-0">
            <span
              v-if="svc.healthy"
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"
            ></span>
            <span
              class="relative inline-flex rounded-full h-3 w-3"
              :class="svc.healthy ? 'bg-emerald-500' : 'bg-red-500'"
            ></span>
          </span>
          <div class="min-w-0">
            <div class="font-medium text-gray-100 truncate">{{ svc.label }}</div>
            <div class="text-xs text-gray-500 truncate">
              <span :class="svc.healthy ? 'text-emerald-400' : 'text-red-400'">{{ svc.detail }}</span>
              <span v-if="svc.httpStatus !== null"> · {{ svc.httpStatus }}</span>
              <span v-if="svc.latencyMs !== null" class="font-mono"> · {{ svc.latencyMs }}ms</span>
            </div>
          </div>
        </div>
        <button
          @click="restartService(svc.container)"
          :disabled="restarting[svc.container]"
          class="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-50"
          :title="`docker restart ${svc.container}`"
        >
          {{ restarting[svc.container] ? 'Restarting…' : 'Restart' }}
        </button>
      </div>

      <div v-if="total === 0" class="bg-gray-800 p-8 text-center text-gray-500 col-span-full">
        {{ loading ? 'Checking services…' : 'No services configured' }}
      </div>
    </div>
  </div>
</template>
