module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return
  const [{ execFileSync }, { join }] = await Promise.all([
    import('node:child_process'),
    import('node:path'),
  ])
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
