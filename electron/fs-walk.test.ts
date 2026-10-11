import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIgnoredName, walkFiles } from './fs-walk.js'

describe('filesystem walk', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) {
      await chmod(join(root, 'unreadable'), 0o700).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
    root = undefined
    vi.restoreAllMocks()
  })

  it('ignores system files and continues past an unreadable directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'gemma-fs-walk-'))
    await mkdir(join(root, 'nested'))
    await mkdir(join(root, '.hidden'))
    await mkdir(join(root, '$RECYCLE.BIN'))
    await mkdir(join(root, 'System Volume Information'))
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, 'unreadable'))
    await writeFile(join(root, 'keep.jpg'), 'image')
    await writeFile(join(root, 'nested', 'keep.txt'), 'text')
    await writeFile(join(root, 'desktop.ini'), 'system')
    await writeFile(join(root, 'ThUmBs.Db'), 'system')
    await writeFile(join(root, 'ehThumbs.db'), 'system')
    await writeFile(join(root, '.hidden', 'hidden.txt'), 'hidden')
    await writeFile(join(root, '$RECYCLE.BIN', 'trash.txt'), 'system')
    await writeFile(join(root, 'System Volume Information', 'system.txt'), 'system')
    await writeFile(join(root, 'node_modules', 'package.json'), '{}')
    await writeFile(join(root, 'unreadable', 'secret.txt'), 'secret')

    const isRoot = process.getuid?.() === 0
    if (!isRoot) await chmod(join(root, 'unreadable'), 0)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const paths: string[] = []
    for await (const entry of walkFiles(root)) paths.push(entry.path)

    expect(paths.sort()).toEqual(['keep.jpg', join('nested', 'keep.txt').replaceAll('\\', '/')])
    if (!isRoot) expect(warning).toHaveBeenCalled()

    expect(await readdir(root)).toContain('unreadable')
  })

  it.each([
    ['.hidden', true],
    ['node_modules', true],
    ['NODE_MODULES', true],
    ['$RECYCLE.BIN', true],
    ['$WinREAgent', true],
    ['System Volume Information', true],
    ['system volume information', true],
    ['desktop.ini', true],
    ['Thumbs.DB', true],
    ['eHThUmBs.Db', true],
    ['regular-folder', false],
    ['image.jpg', false],
  ])('classifies %s as ignored=%s', (name, ignored) => {
    expect(isIgnoredName(name)).toBe(ignored)
  })
})
