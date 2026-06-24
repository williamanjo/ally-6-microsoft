import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const stubsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../stubs')
