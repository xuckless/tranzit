import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export default defineEventHandler(async (event) => {
  try {
    const { stdout } = await execAsync('docker stats --no-stream --format "{{json .}}"')
    
    const containers = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .filter((container) => container.Name.toLowerCase().includes('tranzit'))

    return {
      status: 'success',
      data: containers
    }
  } catch (error) {
    console.error('Docker stats error:', error)
    return {
      status: 'error',
      message: 'Failed to fetch docker stats',
      data: []
    }
  }
})