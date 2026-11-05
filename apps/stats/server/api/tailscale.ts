import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export default defineEventHandler(async (event) => {
  try {
    const { stdout } = await execAsync('tailscale status --json')
    const status = JSON.parse(stdout)
    
    const peers = []
    
    // Check Self
    if (status.Self && status.Self.HostName.toLowerCase().includes('tranzit')) {
       peers.push(status.Self)
    }

    // Check Peers
    if (status.Peer) {
      for (const [key, peer] of Object.entries(status.Peer)) {
        if (peer.HostName.toLowerCase().includes('tranzit') || 
            (peer.DNSName && peer.DNSName.toLowerCase().includes('tranzit'))) {
          peers.push(peer)
        }
      }
    }

    return {
      status: 'success',
      data: peers
    }
  } catch (error) {
    console.error('Tailscale status error:', error)
    return {
      status: 'error',
      message: 'Failed to fetch tailscale stats',
      data: []
    }
  }
})