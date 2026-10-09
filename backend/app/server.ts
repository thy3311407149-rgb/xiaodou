import { createApp } from './app.js'
import { config } from './core/config.js'
import { prepareDirectories } from './core/prepare-directories.js'
import { initializeDatabase } from './db/initialize-database.js'

async function startServer(): Promise<void> {
  await prepareDirectories(config)
  initializeDatabase()
  const app = createApp()
  app.listen(config.port, config.host, () => {
    console.log(`Backend listening at http://${config.host}:${config.port}`)
  })
}

startServer().catch((error: unknown) => {
  console.error('Backend failed to start', error)
  process.exitCode = 1
})
