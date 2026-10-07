import { spawn } from 'node:child_process'

const project = process.cwd()
const hostOwner = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined
const ownershipRepair = hostOwner
  ? `trap 'for path in /project/node_modules /project/public/ort /project/dist /project/dist-electron /project/release; do if [ -e "$path" ]; then chown -R ${hostOwner} "$path"; fi; done' EXIT; `
  : ''
const args = [
  'run',
  '--rm',
  '-v',
  `${project}:/project`,
  '-w',
  '/project',
  'electronuserland/builder:wine',
  'bash',
  '-lc',
  `${ownershipRepair}npm ci && npm run build && npx electron-builder --win nsis portable --x64`,
]
const docker = spawn('docker', args, { stdio: 'inherit' })
docker.on('error', (error) => {
  console.error(`无法启动 Docker：${error.message}`)
  process.exitCode = 1
})
docker.on('exit', (code) => {
  process.exitCode = code || 0
})
