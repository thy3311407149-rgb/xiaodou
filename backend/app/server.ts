import { createApp } from './app.js'
import { config } from './core/config.js'
import { prepareDirectories } from './core/prepare-directories.js'
import { initializeDatabase } from './db/initialize-database.js'
import { TaskExecutor } from './services/task-executor.js'

async function startServer(): Promise<void> {
  await prepareDirectories(config)
  initializeDatabase()
  const executor = new TaskExecutor()
  executor.recoverInterruptedTasks()
  const app = createApp()
  const server = app.listen(config.port, config.host, () => {
    try {
      executor.start()
      if (!executor.isRunning()) {
        throw new Error('Task executor failed to start')
      }
      console.log(`Backend listening at http://${config.host}:${config.port}`)
    } catch (error: unknown) {
      console.error('Task executor failed to start', error)
      server.close()
      process.exitCode = 1
    }
  })
  server.on('error', (error: unknown) => {
    console.error('Backend failed to start', error)
    process.exitCode = 1
  })
}

startServer().catch((error: unknown) => {
  console.error('Backend failed to start', error)
  process.exitCode = 1
})
