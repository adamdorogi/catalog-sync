import { spawn } from 'node:child_process'

const children = ['api', 'worker', 'web'].map((service) =>
  spawn(process.execPath, [process.env.npm_execpath, 'run', `dev:${service}`], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  }),
)

let stopping = false
function stop(signal, code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) {
    if (!child.pid) continue
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal, 0))
}
for (const child of children) {
  child.once('exit', (code) => stop('SIGTERM', code ?? 1))
  child.once('error', (error) => {
    console.error(error.message)
    stop('SIGTERM', 1)
  })
}
