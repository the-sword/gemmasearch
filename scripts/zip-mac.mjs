import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const releaseDir = join(projectRoot, 'release')
const bundles = [
  { directory: 'mac', architecture: 'x64' },
  { directory: 'mac-arm64', architecture: 'arm64' },
]
const zipHelp = spawnSync('zip', ['-h'], { encoding: 'utf8' })
const hasZip = !zipHelp.error

const pythonZip = String.raw`
import os
import stat
import sys
import zipfile

bundle, output = sys.argv[1:]

with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for current, directories, files in os.walk(bundle, topdown=True, followlinks=False):
        symlink_dirs = [name for name in directories if os.path.islink(os.path.join(current, name))]
        directories[:] = [name for name in directories if name not in symlink_dirs]
        relative = os.path.relpath(current, os.path.dirname(bundle))
        info = zipfile.ZipInfo(relative.rstrip(os.sep) + '/')
        info.create_system = 3
        info.external_attr = (stat.S_IFDIR | 0o755) << 16
        archive.writestr(info, b'')

        for name in symlink_dirs + files:
            path = os.path.join(current, name)
            arcname = os.path.relpath(path, os.path.dirname(bundle)).replace(os.sep, '/')
            if os.path.islink(path):
                info = zipfile.ZipInfo(arcname)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.fsencode(os.readlink(path)))
            elif os.path.isfile(path):
                archive.write(path, arcname, compress_type=zipfile.ZIP_DEFLATED)
`

for (const { directory, architecture } of bundles) {
  const bundle = join(releaseDir, directory, 'GemmaSearch.app')
  if (!existsSync(bundle)) throw new Error(`找不到 macOS 应用包：${bundle}`)

  const output = join(releaseDir, `GemmaSearch-${version}-mac-${architecture}.zip`)
  if (existsSync(output)) rmSync(output)

  if (hasZip) {
    const result = spawnSync('zip', ['-qry', '-y', output, 'GemmaSearch.app'], {
      cwd: dirname(bundle),
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`zip ${architecture} 失败，退出码 ${result.status}`)
  } else {
    const result = spawnSync('python3', ['-c', pythonZip, bundle, output], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Python zip ${architecture} 失败，退出码 ${result.status}`)
  }

  console.log(`${output} ${statSync(output).size} bytes`)
}

for (const oldName of [
  `GemmaSearch-${version}-mac.zip`,
  `GemmaSearch-${version}-arm64-mac.zip`,
  `GemmaSearch-${version}-mac.zip.blockmap`,
  `GemmaSearch-${version}-arm64-mac.zip.blockmap`,
]) {
  const oldPath = join(releaseDir, oldName)
  if (existsSync(oldPath)) rmSync(oldPath)
}
