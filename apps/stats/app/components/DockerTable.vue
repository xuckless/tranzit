<script setup>
/**
 * Presentational, sortable Docker stats table. Sort state is owned by the parent
 * (so multiple tables can share one sort); clicking a header emits `sort` with the
 * column key.
 */
defineProps({
  containers: { type: Array, default: () => [] },
  sortKey: { type: String, default: 'name' },
  sortDir: { type: String, default: 'asc' },
  emptyText: { type: String, default: 'No containers found' },
})

const emit = defineEmits(['sort'])

const columns = [
  { key: 'name', label: 'Container', align: 'left' },
  { key: 'cpu', label: 'CPU', align: 'left' },
  { key: 'mem', label: 'Memory', align: 'left' },
  { key: 'net', label: 'Net I/O', align: 'left' },
  { key: 'pids', label: 'PIDs', align: 'left' },
]
</script>

<template>
  <div class="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden shadow-sm">
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm whitespace-nowrap">
        <thead class="uppercase tracking-wider text-xs text-gray-500 bg-gray-900/40">
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              scope="col"
              class="px-6 py-3 font-medium cursor-pointer select-none hover:text-gray-300 transition-colors"
              @click="emit('sort', col.key)"
            >
              <span class="inline-flex items-center gap-1">
                {{ col.label }}
                <span class="text-gray-600 w-2">
                  <template v-if="sortKey === col.key">{{ sortDir === 'asc' ? '▲' : '▼' }}</template>
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700/60">
          <tr v-for="container in containers" :key="container.ID" class="hover:bg-gray-700/40 transition-colors">
            <td class="px-6 py-3.5 font-medium text-gray-200">{{ container.Name }}</td>
            <td class="px-6 py-3.5">
              <div class="flex items-center gap-2">
                <span class="w-12 tabular-nums text-gray-300">{{ container.CPUPerc }}</span>
                <div class="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full bg-blue-500" :style="{ width: container.CPUPerc }"></div>
                </div>
              </div>
            </td>
            <td class="px-6 py-3.5 tabular-nums text-gray-300">{{ container.MemUsage }}</td>
            <td class="px-6 py-3.5 font-mono text-xs text-gray-400">{{ container.NetIO }}</td>
            <td class="px-6 py-3.5 tabular-nums text-gray-400">{{ container.PIDs }}</td>
          </tr>
          <tr v-if="containers.length === 0">
            <td colspan="5" class="px-6 py-8 text-center text-gray-500">{{ emptyText }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
