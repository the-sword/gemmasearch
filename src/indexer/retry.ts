import type { FileEntry, FileRecord } from '../host/types'

export function shouldReindexFile(
  previous: FileRecord | undefined,
  entry: FileEntry,
  retryErrors = true,
  retryEnabledModality = false,
): boolean {
  return !previous ||
    (retryErrors && previous.status === 'error') ||
    retryEnabledModality ||
    previous.size !== entry.size ||
    previous.mtime !== entry.mtime
}
