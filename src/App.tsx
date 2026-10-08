import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type ReactNode } from 'react'
import { EngineClient } from './engine/client'
import type { EngineStatus, EmbedInput, SearchHit, SearchResult } from './engine/protocol'
import { exportLibraryPack, importLibraryPack } from './engine/pack-io'
import { getFile, getFiles, getItems, getThumb, listLibraries, readSetting, removeLibrary, saveLibrary, saveSetting } from './engine/store'
import { host } from './host'
import type { FileRecord, Library, Modality, SearchItem, ThumbnailRecord } from './host/types'
import { createFilesLibrary, forgetSessionLibrary, hasSessionLibrary } from './host/web'
import { Indexer, type IndexProgress } from './indexer/indexer'
import { translate } from './i18n'
import { decodeAudio, decodeMedia } from './media/decode'
import {
  DEFAULT_SETTINGS,
  estimateModelDownloadMB,
  modelSignature,
  normalizeSettings,
  WEIGHT_PROFILES,
  type Settings,
  type WeightProfile,
} from './settings'
import { Icon } from './ui/Icons'
import './App.css'

type Page = 'search' | 'detail' | 'libraries' | 'settings' | 'onboarding'
type EnrichedHit = SearchHit & { file?: FileRecord; thumb?: ThumbnailRecord }
const MODALITIES: Modality[] = ['image', 'video', 'audio', 'pdf', 'text']
function fileExtension(path: string): string {
  return path.split('.').at(-1)?.toUpperCase() || 'FILE'
}

function formatTime(value?: number): string {
  if (value === undefined) return ''
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [libraries, setLibraries] = useState<Library[]>([])
  const [files, setFiles] = useState<FileRecord[]>([])
  const [page, setPage] = useState<Page>('onboarding')
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [loadProgress, setLoadProgress] = useState({ percent: 0, file: '' })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [progress, setProgress] = useState<Record<string, IndexProgress>>({})
  const [query, setQuery] = useState('')
  const [queryImage, setQueryImage] = useState<Blob | null>(null)
  const [queryImageUrl, setQueryImageUrl] = useState('')
  const [selectedModalities, setSelectedModalities] = useState<Modality[]>([])
  const [selectedLibraries, setSelectedLibraries] = useState<string[]>([])
  const [threshold, setThreshold] = useState(0)
  const [listMode, setListMode] = useState(false)
  const [results, setResults] = useState<SearchResult | null>(null)
  const [enrichedHits, setEnrichedHits] = useState<EnrichedHit[]>([])
  const [selectedHit, setSelectedHit] = useState<EnrichedHit | null>(null)
  const [detailItem, setDetailItem] = useState<SearchItem | null>(null)
  const [recording, setRecording] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const packInput = useRef<HTMLInputElement>(null)
  const engineRef = useRef<EngineClient | null>(null)
  const engineStatusRef = useRef<EngineStatus | null>(null)
  const indexers = useRef(new Map<string, Indexer>())
  const watchers = useRef(new Map<string, () => void>())
  const watchTimers = useRef(new Map<string, number>())
  const queuedRescans = useRef(new Set<string>())
  const loadedSettings = useRef('')
  const recorder = useRef<MediaRecorder | null>(null)
  const t = (key: Parameters<typeof translate>[1]) => translate(settings, key)
  const activeDtype = engineStatus?.actualDtype ?? WEIGHT_PROFILES[settings.weights]
  const activeProfile = engineStatus?.profile ?? settings.weights
  const activeModelSignature = modelSignature(settings, activeDtype)

  useEffect(() => {
    if (!queryImage) {
      setQueryImageUrl('')
      return
    }
    const url = URL.createObjectURL(queryImage)
    setQueryImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [queryImage])

  const refreshData = useCallback(async () => {
    const [savedLibraries, savedFiles] = await Promise.all([listLibraries(), getFiles()])
    setLibraries(savedLibraries)
    setFiles(savedFiles)
  }, [])

  useEffect(() => {
    void Promise.all([
      readSetting<Settings>('settings'),
      readSetting<boolean>('onboardingComplete'),
      refreshData(),
    ]).then(([savedSettings, onboardingComplete]) => {
      if (savedSettings) setSettings(normalizeSettings(savedSettings))
      if (onboardingComplete) setPage('search')
    })
  }, [refreshData])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const ensureEngine = useCallback(async (force = false): Promise<EngineClient> => {
    const client = engineRef.current ?? new EngineClient()
    engineRef.current = client
    const signature = JSON.stringify(settings)
    if (force || loadedSettings.current !== signature) {
      setBusy(true)
      setLoadProgress({ percent: 0, file: '' })
      try {
        const status = await client.init(settings, (percent, file) => setLoadProgress({ percent, file: file || '' }))
        engineStatusRef.current = status
        setEngineStatus(status)
        loadedSettings.current = signature
      } finally {
        setBusy(false)
      }
    }
    return client
  }, [settings])

  const updateSettings = (patch: Partial<Settings>) => {
    const nextSettings = { ...settings, ...patch }
    engineStatusRef.current = null
    setEngineStatus(null)
    loadedSettings.current = ''
    setSettings(nextSettings)
    void saveSetting('settings', nextSettings)
  }

  const startIndexing = useCallback(async (library: Library) => {
    if (indexers.current.has(library.id)) {
      queuedRescans.current.add(library.id)
      return
    }
    try {
      const engine = await ensureEngine()
      const signature = modelSignature(settings, engineStatusRef.current?.actualDtype)
      if (library.modelSig !== signature) {
        for (const file of await getFiles(library.id)) await engine.removeFile(`${library.id}:${file.path}`)
      }
      const updatedLibrary = { ...library, modelSig: signature }
      await saveLibrary(updatedLibrary)
      const indexer = new Indexer(engine, settings)
      indexers.current.set(library.id, indexer)
      indexer.onProgress((value) => setProgress((current) => ({ ...current, [library.id]: value })))
      try {
        await indexer.scan(updatedLibrary)
      } finally {
        indexers.current.delete(library.id)
        if (queuedRescans.current.delete(library.id)) {
          window.setTimeout(() => void startIndexing(updatedLibrary), 0)
        }
      }
      await refreshData()
      setToast('索引已更新')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '索引失败')
    }
  }, [ensureEngine, refreshData, settings])

  const addFiles = async (selected: File[]) => {
    if (!selected.length) return
    const library = createFilesLibrary(selected, settings, undefined, engineStatusRef.current?.actualDtype)
    await saveLibrary(library)
    await refreshData()
    setPage('libraries')
    void startIndexing(library)
  }

  const addFolder = async () => {
    try {
      const source = await host.pickFolder()
      if (!source) return
      const library: Library = {
        id: crypto.randomUUID(),
        name: source.name,
        kind: host.kind === 'electron' || source.handle ? 'folder' : 'files',
        rootPath: source.rootPath,
        handle: source.handle,
        modelSig: modelSignature(settings, engineStatusRef.current?.actualDtype),
        createdAt: Date.now(),
      }
      await saveLibrary(library)
      await refreshData()
      void startIndexing(library)
      setPage('libraries')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法添加文件夹')
    }
  }

  useEffect(() => {
    const folderLibraries = libraries.filter((library) => library.kind === 'folder' && library.rootPath)
    let disposed = false
    void (async () => {
      try {
        await host.registerRoots?.(folderLibraries.map((library) => library.rootPath!))
      } catch (error) {
        if (!disposed) setToast(error instanceof Error ? error.message : '无法注册文件夹')
        return
      }
      if (disposed || !host.watch) return
      for (const library of folderLibraries) {
        if (disposed) break
        const stop = host.watch(library, () => {
          const previousTimer = watchTimers.current.get(library.id)
          if (previousTimer !== undefined) window.clearTimeout(previousTimer)
          const timer = window.setTimeout(() => {
            watchTimers.current.delete(library.id)
            void startIndexing(library)
          }, 350)
          watchTimers.current.set(library.id, timer)
        })
        watchers.current.set(library.id, stop)
      }
    })()
    return () => {
      disposed = true
      for (const stop of watchers.current.values()) stop()
      watchers.current.clear()
      for (const timer of watchTimers.current.values()) window.clearTimeout(timer)
      watchTimers.current.clear()
    }
  }, [libraries, startIndexing])

  const runSearch = async (event?: FormEvent, similarItemId?: number) => {
    event?.preventDefault()
    if (!query.trim() && !queryImage && similarItemId === undefined) {
      setToast('请输入搜索内容或添加一张图片')
      return
    }
    try {
      const engine = await ensureEngine()
      const signature = modelSignature(settings, engineStatusRef.current?.actualDtype)
      const compatibleLibraries = libraries
        .filter((library) => library.modelSig === signature)
        .filter((library) => !selectedLibraries.length || selectedLibraries.includes(library.id))
      let searchQuery: EmbedInput | { itemId: number }
      if (similarItemId !== undefined) {
        searchQuery = { itemId: similarItemId }
      } else if (queryImage) {
        const decoded = await decodeMedia(queryImage, queryImage.type === 'image/png' ? 'query.png' : 'query.jpg', settings)
        const image = decoded.chunks[0]?.input
        if (!image || image.kind !== 'image') throw new Error('无法解码查询图片')
        searchQuery = query.trim()
          ? { kind: 'mixed', text: query.trim(), data: image.data, width: image.width, height: image.height }
          : image
      } else {
        searchQuery = { kind: 'text', text: query.trim(), role: 'query' }
      }
      const result = await engine.search({
        query: searchQuery,
        modalities: selectedModalities.length ? selectedModalities : undefined,
        libIds: compatibleLibraries.map((library) => library.id),
        minScore: threshold,
        limit: 60,
      })
      setResults(result)
      setPage('search')
      const enriched = await Promise.all(result.hits.map(async (hit) => {
        const [file, thumb] = await Promise.all([getFile(hit.fileKey), getThumb(hit.fileKey)])
        return { ...hit, file, thumb }
      }))
      setEnrichedHits(enriched)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '搜索失败')
    }
  }

  const openDetail = async (hit: EnrichedHit) => {
    const item = hit.segments[0] ? (await getItems(hit.libId)).find((stored) => stored.id === hit.segments[0]?.itemId) || null : null
    setSelectedHit(hit)
    setDetailItem(item)
    setPage('detail')
  }

  const handlePaste = (event: ClipboardEvent) => {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
    const file = image?.getAsFile()
    if (file) setQueryImage(file)
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const dropped = Array.from(event.dataTransfer.files)
    if (!dropped.length) return
    if (page === 'search' && dropped.length === 1 && dropped[0]!.type.startsWith('image/')) {
      setQueryImage(dropped[0]!)
    } else {
      if (host.kind === 'electron') {
        setToast('Electron 版本请添加文件夹')
        return
      }
      void addFiles(dropped)
    }
  }

  const startRecording = async () => {
    if (recording) {
      recorder.current?.stop()
      return
    }
    if (!settings.modalities.audio) {
      setToast('请先在设置中启用音频模态')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      const chunks: BlobPart[] = []
      mediaRecorder.ondataavailable = (event) => chunks.push(event.data)
      mediaRecorder.onstop = () => {
        const audio = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' })
        void decodeAudio(audio, settings).then(async (decoded) => {
          const chunk = decoded.chunks[0]
          if (chunk?.input.kind === 'audio') {
            const engine = await ensureEngine()
            const result = await engine.search({ query: chunk.input })
            setResults(result)
            setEnrichedHits(await Promise.all(result.hits.map(async (hit) => {
              const [file, thumb] = await Promise.all([getFile(hit.fileKey), getThumb(hit.fileKey)])
              return { ...hit, file, thumb }
            })))
            setPage('search')
          }
        }).catch((error: unknown) => setToast(error instanceof Error ? error.message : '音频解码失败'))
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
      }
      recorder.current = mediaRecorder
      mediaRecorder.start()
      setRecording(true)
      window.setTimeout(() => {
        if (mediaRecorder.state === 'recording') mediaRecorder.stop()
      }, 30_000)
    } catch {
      setToast('无法访问麦克风，请检查浏览器权限')
    }
  }

  const importPack = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const { library, mismatch } = await importLibraryPack(
        file,
        settings,
        engineStatusRef.current?.actualDtype,
      )
      await engineRef.current?.refresh()
      await refreshData()
      setToast(mismatch ? `${library.name}：${t('rebuild')}` : `已导入 ${library.name}`)
      setPage('libraries')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '导入失败')
    } finally {
      event.target.value = ''
    }
  }

  const remove = async (library: Library) => {
    if (!window.confirm(`确定移除“${library.name}”？`)) return
    if (engineRef.current) await engineRef.current.removeLibrary(library.id)
    else await removeLibrary(library.id)
    forgetSessionLibrary(library)
    await refreshData()
    setToast('索引库已移除')
  }

  const beginExport = async (library: Library) => {
    try {
      const blob = await exportLibraryPack(library)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${library.name}.gsidx`
      anchor.click()
      URL.revokeObjectURL(url)
      setToast('索引包已导出')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '导出失败')
    }
  }

  const doSimilar = async () => {
    if (!detailItem?.id) return
    await runSearch(undefined, detailItem.id)
  }

  const copyPath = async () => {
    if (!selectedHit?.file) return
    await navigator.clipboard.writeText(selectedHit.file.path)
    setToast('路径已复制')
  }

  const selectedLibrary = selectedHit ? libraries.find((library) => library.id === selectedHit.libId) : undefined
  const sourceUnavailable = Boolean(selectedLibrary?.kind === 'imported' || (selectedLibrary?.kind === 'files' && !hasSessionLibrary(selectedLibrary)))
  const detailPreview = selectedHit?.modality === 'pdf'
    ? selectedHit.thumb?.pages?.[selectedHit.segments[0]?.page || 1] || selectedHit.thumb?.jpeg
    : selectedHit?.thumb?.jpeg
  const activeNav: Page = page
  const countByModality = useMemo(() => MODALITIES.map((modality) => ({
    modality,
    count: files.filter((file) => file.status === 'ok' && file.modality === modality).length,
  })), [files])

  return (
    <div className="app-shell" onPaste={handlePaste} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Icon name="search" size={21} /></div>
          <div><strong>Gemma</strong><span>多模态搜索</span></div>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <button className={activeNav === 'search' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('search')}><Icon name="search" />{t('search')}</button>
          <button className={activeNav === 'libraries' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('libraries')}><Icon name="folder" />{t('libraries')}</button>
          <button className={activeNav === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('settings')}><Icon name="settings" />{t('settings')}</button>
        </nav>
        <section className="library-sidebar">
          <div className="section-title"><span>{t('librariesTitle')}</span><button className="icon-button" title={t('addFolder')} onClick={() => void addFolder()}>＋</button></div>
          {libraries.length === 0 ? <p className="sidebar-empty">还没有索引库</p> : libraries.map((library) => (
            <button key={library.id} className={`library-item ${selectedLibraries.includes(library.id) ? 'selected' : ''}`} onClick={() => setSelectedLibraries((current) => current.includes(library.id) ? current.filter((id) => id !== library.id) : [...current, library.id])}>
              <Icon name="folder" size={15} /><span>{library.name}</span><small>{files.filter((file) => file.libId === library.id && file.status === 'ok').length}</small>
            </button>
          ))}
        </section>
        <div className="sidebar-actions">
          {host.kind === 'web' && <button className="button secondary full" onClick={() => fileInput.current?.click()}><span>＋</span>{t('addFiles')}</button>}
          <button className="button text full" onClick={() => void addFolder()}><Icon name="folder" size={16} />{t('addFolder')}</button>
          <input ref={fileInput} hidden type="file" multiple onChange={(event) => { const selected = Array.from(event.target.files || []); event.currentTarget.value = ''; void addFiles(selected) }} />
        </div>
        <div className="status-footer">
          <div className="status-row"><span className={`status-dot ${engineStatus ? 'ready' : ''}`} />{engineStatus ? `${engineStatus.backend.toUpperCase()} · ${activeProfile}` : '模型未加载'}</div>
          {busy && <div className="mini-progress"><i style={{ width: `${loadProgress.percent}%` }} /></div>}
          {engineStatus && <div className="status-caption">{engineStatus.actualDtype.model} · {engineStatus.actualDtype.vision_encoder} · {engineStatus.actualDtype.audio_encoder}</div>}
          {Object.entries(progress).filter(([, item]) => item.total > 0).slice(0, 1).map(([id, item]) => <div className="status-caption" key={id}>索引中 {item.done}/{item.total}</div>)}
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>本地工作区</span><span className="crumb-separator">/</span><strong>{t(activeNav)}</strong></div>
          <div className="top-actions"><span className="local-badge"><span />本地运行</span><button className="avatar" onClick={() => setPage('settings')} aria-label={t('settings')}>G</button></div>
        </header>

        {page === 'onboarding' && (
          <section className="onboarding page-content">
            <div className="welcome-card">
              <div className="welcome-orb"><Icon name="search" size={34} /></div>
              <p className="eyebrow">EMBEDDINGGEMMA 2</p>
              <h1>让本地文件，<span>一搜即得</span></h1>
              <p className="welcome-copy">在你的设备上搜索图片、视频、录音和文档。所有推理都在浏览器本地完成，文件不会上传。</p>
              <div className="capability-grid">
                <label className="capability"><input type="checkbox" checked={settings.modalities.vision} onChange={(event) => updateSettings({ modalities: { ...settings.modalities, vision: event.target.checked } })} /><Icon name="image" /><span><b>图片与视频</b><small>视觉内容检索</small></span></label>
                <label className="capability"><input type="checkbox" checked={settings.modalities.audio} onChange={(event) => updateSettings({ modalities: { ...settings.modalities, audio: event.target.checked } })} /><Icon name="audio" /><span><b>音频</b><small>声音与录音检索</small></span></label>
              </div>
              <div className="onboarding-weights">
                <h2>模型权重</h2>
                <WeightProfilePicker
                  settings={settings}
                  name="onboarding-weights"
                  onChange={(weights) => updateSettings({ weights })}
                />
              </div>
              <button className="button primary welcome-button" disabled={busy} onClick={() => {
                void ensureEngine(true).then(() => {
                  void saveSetting('onboardingComplete', true)
                  setPage('search')
                  setToast('模型已就绪，可添加文件')
                }).catch((error: unknown) => setToast(error instanceof Error ? error.message : '模型加载失败'))
              }}>{busy ? `${t('modelDownload')} ${loadProgress.percent}%` : '加载模型并开始'}<span>→</span></button>
              <div className="welcome-details"><span className={`gpu-pill ${navigator.gpu ? 'available' : ''}`}>◈ {navigator.gpu ? 'WebGPU 可用' : '将使用 WASM CPU'}</span><span>默认 256 维</span></div>
              {busy && <div className="load-track"><i style={{ width: `${loadProgress.percent}%` }} /></div>}
              {loadProgress.file && <small className="load-file">{loadProgress.file}</small>}
            </div>
            <div className="privacy-note"><span>◉</span><div><b>你的数据始终留在本地</b><small>模型仅在首次使用时下载，索引和媒体内容保存在此浏览器中。</small></div></div>
          </section>
        )}

        {page === 'search' && (
          <section className="page-content search-page">
            {libraries.some((library) => library.modelSig !== activeModelSignature) && <div className="rebuild-banner"><span>ⓘ</span><div><b>{t('rebuild')}</b><small>当前模型设置与部分索引库不同，需重新扫描后才能参与搜索。</small></div><button className="button secondary small" onClick={() => setPage('libraries')}>查看索引库</button></div>}
            <div className="page-heading"><div><p className="eyebrow">本地语义搜索</p><h1>{t('searchTitle')}</h1><p className="subtitle">{t('searchHint')}</p></div>{libraries.length > 0 && <div className="indexed-summary"><b>{files.filter((file) => file.status === 'ok').length}</b><span>个文件已索引</span></div>}</div>
            <form className="search-composer" onSubmit={(event) => void runSearch(event)}>
              <Icon name="search" size={20} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：猫咪在沙发上睡觉、海边的日落……" aria-label="搜索内容" />
              {queryImage && <div className="query-image"><img src={queryImageUrl} alt="查询图片" /><button type="button" onClick={() => setQueryImage(null)}>×</button></div>}
              <div className="composer-actions">
                <input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => { setQueryImage(event.target.files?.[0] || null); event.currentTarget.value = '' }} />
                <button className="button secondary small" type="button" onClick={() => imageInput.current?.click()}>{t('addImage')}</button>
                <button className={`button secondary small ${recording ? 'recording' : ''}`} type="button" onClick={() => void startRecording()}>{recording ? '停止录音' : t('record')}</button>
                <button className="button primary small" type="submit">{t('searchButton')}<span>⌕</span></button>
              </div>
            </form>
            <div className="filter-row">
              <div className="filter-chips"><button className={selectedModalities.length === 0 ? 'chip active' : 'chip'} onClick={() => setSelectedModalities([])}>{t('all')}<small>{files.filter((file) => file.status === 'ok').length}</small></button>
                {countByModality.map(({ modality, count }) => <button key={modality} className={selectedModalities.includes(modality) ? 'chip active' : 'chip'} onClick={() => setSelectedModalities((current) => current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality])}>{t(modality)}<small>{count}</small></button>)}</div>
              <div className="result-tools">
                <label className="select-with-label"><span>资料库</span><select value={selectedLibraries.length === 1 ? selectedLibraries[0] : 'all'} onChange={(event) => setSelectedLibraries(event.target.value === 'all' ? [] : [event.target.value])}><option value="all">全部资料库</option>{libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>
                <label className="threshold-control" title={t('threshold')}>阈值 <input type="range" min="0" max="0.8" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><span>{Math.round(threshold * 100)}%</span></label>
                <div className="view-toggle"><button className={!listMode ? 'active' : ''} title={t('grid')} onClick={() => setListMode(false)}>▦</button><button className={listMode ? 'active' : ''} title={t('list')} onClick={() => setListMode(true)}>☷</button></div>
              </div>
            </div>
            {results && <div className="results-summary"><span>找到 <b>{results.hits.length}</b> 个结果</span><span>·</span><span>{results.totalVectors.toLocaleString()} 条向量</span><span>·</span><span>{results.elapsedMs.toFixed(0)} ms</span></div>}
            {enrichedHits.length ? <div className={listMode ? 'result-list' : 'result-grid'}>{enrichedHits.map((hit) => <ResultCard key={hit.fileKey} hit={hit} listMode={listMode} onOpen={() => void openDetail(hit)} />)}</div> : <div className="search-empty"><div className="empty-illustration"><div className="empty-circle"><Icon name="image" size={36} /></div><span className="spark spark-one">✦</span><span className="spark spark-two">✧</span><span className="empty-dash" /></div><h2>{results ? '没有匹配结果' : t('noResults')}</h2><p>{libraries.length ? '尝试更换关键词、筛选条件或降低相似度阈值。' : '先添加文件，Gemma 会在本地建立可搜索的语义索引。'}</p>{!libraries.length && <button className="button secondary" onClick={() => host.kind === 'electron' ? void addFolder() : fileInput.current?.click()}>＋ {host.kind === 'electron' ? '添加文件夹' : '添加一些文件'}</button>}</div>}
          </section>
        )}

        {page === 'detail' && selectedHit && (
          <section className="page-content detail-page">
            <button className="back-link" onClick={() => setPage('search')}>← 返回搜索结果</button>
            <div className="detail-heading"><div><p className="eyebrow">{selectedHit.modality.toUpperCase()} · 相似度 {Math.round(selectedHit.score * 100)}%</p><h1>{selectedHit.file?.name || selectedHit.fileKey.split(':').at(-1)}</h1><p className="subtitle">{selectedHit.file?.path}</p></div><div className="detail-actions"><button className="button secondary small" onClick={() => void doSimilar()}>{t('similar')}</button><button className="button secondary small" onClick={() => void copyPath()}>{t('copyPath')}</button></div></div>
            {sourceUnavailable && <div className="source-unavailable">原文件需重新添加。索引和已保存的预览仍可在本地使用。</div>}
            <div className="detail-layout"><div className="detail-primary">
              {sourceUnavailable ? <div className="detail-media">{detailPreview ? <DetailImage blob={detailPreview} alt={selectedHit.file?.name || '预览'} /> : <div className="media-placeholder"><Icon name={selectedHit.modality === 'pdf' ? 'file' : 'image'} size={52} /></div>}</div> : selectedHit.modality === 'video' && selectedLibrary && selectedHit.file ? <VideoDetail library={selectedLibrary} file={selectedHit.file} hit={selectedHit} /> : selectedHit.modality === 'audio' && selectedLibrary && selectedHit.file ? <AudioDetail library={selectedLibrary} file={selectedHit.file} hit={selectedHit} /> : <div className="detail-media">{detailPreview ? <DetailImage blob={detailPreview} alt={selectedHit.file?.name || '预览'} /> : <div className="media-placeholder"><Icon name={selectedHit.modality === 'pdf' ? 'file' : 'image'} size={52} /></div>}<span className="media-format">{selectedHit.modality === 'pdf' ? `第 ${selectedHit.segments[0]?.page || 1} 页` : fileExtension(selectedHit.file?.name || '')}</span></div>}
              {selectedHit.modality === 'pdf' && <div className="detail-callout">命中页面：第 {selectedHit.segments[0]?.page || 1} 页</div>}
              {selectedHit.modality === 'text' && <article className="snippet-panel"><h3>文本片段</h3><p>{detailItem?.text || '打开此文件查看完整内容。'}</p></article>}
              </div><aside className="detail-info">
                <div className="panel"><h3>文件信息</h3><dl><dt>类型</dt><dd>{t(selectedHit.modality)}</dd><dt>大小</dt><dd>{selectedHit.file ? `${(selectedHit.file.size / 1024).toFixed(1)} KB` : '—'}</dd><dt>修改时间</dt><dd>{selectedHit.file ? new Date(selectedHit.file.mtime).toLocaleDateString(settings.lang === 'zh' ? 'zh-CN' : 'en-US') : '—'}</dd><dt>所在资料库</dt><dd>{selectedLibrary?.name || '—'}</dd></dl></div>
                <div className="panel"><h3>匹配片段</h3><div className="segment-list">{selectedHit.segments.map((segment, index) => <button key={segment.itemId} className={index === 0 ? 'segment-item active' : 'segment-item'} onClick={() => { const found = enrichedHits.find((hit) => hit.fileKey === selectedHit.fileKey); if (found) setSelectedHit({ ...found, segments: [segment, ...found.segments.filter((item) => item.itemId !== segment.itemId)] }) }}><span>{segment.page ? `第 ${segment.page} 页` : `${formatTime(segment.start)}${segment.end ? ` — ${formatTime(segment.end)}` : ''}`}</span><b>{Math.round(segment.score * 100)}%</b></button>)}</div></div>
                <div className="panel detail-file-actions">{selectedLibrary && selectedHit.file && <button className="button secondary full" onClick={() => void host.openPath?.(selectedLibrary, selectedHit.file!)}>{t('open')} ↗</button>}{selectedLibrary && selectedHit.file && host.showInFolder && <button className="button secondary full" onClick={() => void host.showInFolder?.(selectedLibrary, selectedHit.file!)}>{t('showFolder')}</button>}</div>
              </aside></div>
          </section>
        )}

        {page === 'libraries' && (
          <section className="page-content management-page">
            <div className="page-heading compact"><div><p className="eyebrow">LIBRARY</p><h1>{t('libraries')}</h1><p className="subtitle">管理本地索引、扫描进度和跳过的文件。</p></div><div className="management-buttons"><button className="button secondary" onClick={() => packInput.current?.click()}>{t('import')}</button>{host.kind === 'web' && <button className="button primary" onClick={() => fileInput.current?.click()}>＋ {t('addFiles')}</button>}<button className="button primary" onClick={() => void addFolder()}>＋ {t('addFolder')}</button><input ref={packInput} hidden type="file" accept=".gsidx,application/octet-stream" onChange={(event) => void importPack(event)} /></div></div>
            <div className="library-table-wrap"><table className="library-table"><thead><tr><th>资料库</th><th>类型</th><th>文件</th><th>索引进度</th><th>状态</th><th>操作</th></tr></thead><tbody>
              {libraries.map((library) => {
                const libraryFiles = files.filter((file) => file.libId === library.id)
                const progressValue = progress[library.id]
                const doneCount = progressValue?.done ?? libraryFiles.length
                const totalCount = progressValue?.total ?? libraryFiles.length
                const mismatch = library.modelSig !== activeModelSignature
                const canRescan = library.kind !== 'imported' && (library.kind !== 'files' || hasSessionLibrary(library))
                return <tr key={library.id}><td><div className="library-name"><span className="library-icon"><Icon name="folder" size={17} /></span><div><b>{library.name}</b><small>{library.rootPath?.startsWith('session:') ? (hasSessionLibrary(library) ? '临时会话文件' : '原文件需重新添加') : library.rootPath || '导入的索引'}</small></div></div></td><td><span className="type-badge">{library.kind === 'folder' ? '文件夹' : library.kind === 'imported' ? '导入' : '文件'}</span></td><td>{libraryFiles.length}</td><td><div className="progress-cell"><div className="progress-track"><i style={{ width: `${totalCount ? Math.round(doneCount / totalCount * 100) : libraryFiles.length ? 100 : 0}%` }} /></div><span>{progressValue ? `${doneCount}/${totalCount}` : `${libraryFiles.filter((file) => file.status === 'ok').length} 已索引`}</span></div>{progressValue?.file && <small className="current-task">{progressValue.file}</small>}</td><td><span className={`state-badge ${mismatch ? 'warning' : progressValue ? 'working' : 'ready'}`}>{mismatch ? t('rebuild') : progressValue?.status || '就绪'}</span></td><td><div className="table-actions"><button title={progressValue?.status === '已暂停' ? t('resume') : t('pause')} disabled={!indexers.current.has(library.id)} onClick={() => progressValue?.status === '已暂停' ? indexers.current.get(library.id)?.resume() : indexers.current.get(library.id)?.pause()}>{progressValue?.status === '已暂停' ? '▶' : 'Ⅱ'}</button><button title={canRescan ? t('rescan') : '原文件需重新添加后才能扫描'} disabled={!canRescan} onClick={() => void startIndexing(library)}>↻</button><button title={t('export')} onClick={() => void beginExport(library)}>⇩</button><button title={t('remove')} onClick={() => void remove(library)}>×</button></div></td></tr>
              })}
              {!libraries.length && <tr><td className="table-empty" colSpan={6}>还没有索引库。添加文件或导入 .gsidx 索引包开始。</td></tr>}
            </tbody></table></div>
            <div className="panel skipped-panel"><div className="panel-header"><div><h3>跳过或失败的文件</h3><p>查看无法建立索引的文件和原因。</p></div><span className="count-pill">{files.filter((file) => file.status !== 'ok').length}</span></div>{files.filter((file) => file.status !== 'ok').length ? <div className="skipped-list">{files.filter((file) => file.status !== 'ok').map((file) => <div key={`${file.libId}:${file.path}`}><span className="file-mini">{fileExtension(file.name)}</span><b>{file.name}</b><small>{file.reason}</small></div>)}</div> : <p className="muted">暂无跳过或失败的文件。</p>}</div>
          </section>
        )}

        {page === 'settings' && (
          <section className="page-content settings-page">
            <div className="page-heading compact"><div><p className="eyebrow">PREFERENCES</p><h1>{t('settings')}</h1><p className="subtitle">调整本地模型、索引质量和资源使用。</p></div></div>
            <div className="settings-columns"><div className="settings-main panel">
              <div className="setting-section"><h2>模型与推理</h2>
                <SettingRow title="推理后端" hint="自动优先使用 WebGPU，不可用时回退到 WASM。"><select value={settings.backend} onChange={(event) => updateSettings({ backend: event.target.value as Settings['backend'] })}><option value="auto">自动（WebGPU → WASM）</option><option value="wasm">WASM CPU</option></select></SettingRow>
                <SettingRow title="模型权重" hint="标准权重可由 GPU 与 CPU 共用；GPU 轻量模式更省下载空间。">
                  <WeightProfilePicker
                    settings={settings}
                    name="settings-weights"
                    onChange={(weights) => updateSettings({ weights })}
                  />
                </SettingRow>
                <SettingRow title="向量维度" hint="维度越低，占用空间越小。更改后需重建索引。"><div className="segmented">{([768, 512, 256, 128] as const).map((dim) => <button key={dim} className={settings.dim === dim ? 'active' : ''} onClick={() => updateSettings({ dim })}>{dim}</button>)}</div></SettingRow>
                <SettingRow title="视觉 Token 预算" hint="更高预算可保留更多图片细节，但推理更慢。"><select value={settings.visionTokens} onChange={(event) => updateSettings({ visionTokens: Number(event.target.value) as Settings['visionTokens'] })}>{[70, 140, 280, 560, 1120].map((value) => <option key={value} value={value}>{value} tokens</option>)}</select></SettingRow>
                <SettingRow title="启用模态" hint="关闭未使用的编码器以减少下载和内存。"><div className="toggle-row"><label><input type="checkbox" checked={settings.modalities.vision} onChange={(event) => updateSettings({ modalities: { ...settings.modalities, vision: event.target.checked } })} />图片与视频</label><label><input type="checkbox" checked={settings.modalities.audio} onChange={(event) => updateSettings({ modalities: { ...settings.modalities, audio: event.target.checked } })} />音频</label></div></SettingRow>
              </div>
              <div className="setting-section"><h2>索引性能</h2><SettingRow title="视频片段" hint="视频按时间段抽帧并分别编码。"><select value={settings.videoSegmentSec} onChange={(event) => updateSettings({ videoSegmentSec: Number(event.target.value) as Settings['videoSegmentSec'] })}><option value={8}>8 秒</option><option value={16}>16 秒</option></select></SettingRow><SettingRow title="音频片段" hint="长音频拆分为连续片段。"><select value={settings.audioSegmentSec} onChange={(event) => updateSettings({ audioSegmentSec: Number(event.target.value) as Settings['audioSegmentSec'] })}><option value={30}>30 秒</option><option value={60}>60 秒</option></select></SettingRow><SettingRow title="索引速度" hint="低速会在批次间增加间隔。"><select value={settings.indexSpeed} onChange={(event) => updateSettings({ indexSpeed: event.target.value as Settings['indexSpeed'] })}><option value="low">低 · 200 ms</option><option value="mid">中 · 50 ms</option><option value="high">高 · 无间隔</option></select></SettingRow></div>
              <div className="setting-section"><h2>界面与网络</h2><SettingRow title="模型来源" hint="可切换 Hugging Face 镜像站点。"><select value={settings.modelHost} onChange={(event) => updateSettings({ modelHost: event.target.value as Settings['modelHost'] })}><option value="hf">Hugging Face</option><option value="mirror">HF Mirror</option></select></SettingRow><SettingRow title={t('language')}><select value={settings.lang} onChange={(event) => updateSettings({ lang: event.target.value as Settings['lang'] })}><option value="zh">简体中文</option><option value="en">English</option></select></SettingRow></div>
            </div><aside className="settings-aside">
              <div className="panel backend-panel"><div className="panel-header"><h3>运行状态</h3><span className={`state-badge ${engineStatus ? 'ready' : ''}`}>{engineStatus ? `${engineStatus.backend} · ${engineStatus.profile}` : '未加载'}</span></div><dl><dt>设备</dt><dd>{engineStatus?.adapter || (engineStatus?.backend === 'wasm' ? 'CPU' : '—')}</dd><dt>模型精度</dt><dd>{activeDtype.model}</dd><dt>模型加载</dt><dd>{engineStatus ? `${(engineStatus.loadMs / 1000).toFixed(1)} 秒` : '待启动'}</dd></dl>{engineStatus?.fallbackReason && <p className="fallback-note">{engineStatus.fallbackReason}</p>}</div>
              <div className="panel cache-panel"><span className="cache-icon">⌁</span><h3>模型缓存</h3><p>已下载的模型会保存在此浏览器中，清理后下次使用需要重新下载。</p><button className="button secondary full" onClick={async () => { await caches.delete('transformers-cache'); setToast('模型缓存已清理') }}>清理模型缓存</button></div>
              <div className="privacy-card"><b>隐私设计</b><p>文本、媒体和索引向量均在浏览器中处理。联网仅用于首次获取模型文件。</p></div>
            </aside></div>
          </section>
        )}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function ResultCard({ hit, listMode, onOpen }: { hit: EnrichedHit; listMode: boolean; onOpen: () => void }) {
  const [thumbUrl, setThumbUrl] = useState('')
  useEffect(() => {
    if (!hit.thumb?.jpeg) {
      setThumbUrl('')
      return
    }
    const url = URL.createObjectURL(hit.thumb.jpeg)
    setThumbUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [hit.thumb?.jpeg])
  return <button className={listMode ? 'result-card list-card' : 'result-card'} onClick={onOpen}>
    <div className="result-thumb">{thumbUrl ? <img src={thumbUrl} alt="" /> : <div className={`type-placeholder ${hit.modality}`}><Icon name={hit.modality === 'audio' ? 'audio' : hit.modality === 'video' ? 'video' : hit.modality === 'text' || hit.modality === 'pdf' ? 'file' : 'image'} size={42} /></div>}<span className={`modality-tag ${hit.modality}`}>{hit.modality}</span>{hit.segments[0]?.start !== undefined && <span className="time-tag">{formatTime(hit.segments[0].start)}</span>}{hit.segments[0]?.page && <span className="page-tag">P.{hit.segments[0].page}</span>}</div>
    <div className="result-meta"><div><b>{hit.file?.name || hit.fileKey.split(':').at(-1)}</b><small>{hit.file?.path || hit.fileKey}</small></div><span className="score-pill">{Math.round(hit.score * 100)}%</span></div>
  </button>
}

function DetailImage({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return <img src={url} alt={alt} />
}

function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-label"><b>{title}</b>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>
}

function WeightProfilePicker({
  settings,
  name,
  onChange,
}: {
  settings: Settings
  name: string
  onChange: (weights: WeightProfile) => void
}) {
  const options: Array<{ value: WeightProfile; title: string; detail: string }> = [
    { value: 'standard', title: '标准（GPU/CPU 通用）', detail: 'GPU 与 CPU 使用同一套模型权重' },
    { value: 'gpu-lite', title: 'GPU 轻量', detail: '仅 GPU 使用；退回 CPU 时需要重建索引' },
  ]
  return (
    <div className="weight-options" role="radiogroup" aria-label="模型权重">
      {options.map((option) => (
        <label className={`weight-option ${settings.weights === option.value ? 'selected' : ''}`} key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={settings.weights === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="weight-option-copy">
            <b>{option.value === 'gpu-lite' ? `${option.title}（仅 GPU 使用；退回 CPU 时需要重建索引）` : option.title}</b>
            {option.value === 'standard' && <small>{option.detail}</small>}
          </span>
          <strong>约 {estimateModelDownloadMB(option.value, settings.modalities).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MB</strong>
        </label>
      ))}
    </div>
  )
}

function VideoDetail({ library, file, hit }: { library: Library; file: FileRecord; hit: EnrichedHit }) {
  const [url, setUrl] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    let current = ''
    void host.mediaUrl(library, file).then((mediaUrl) => { current = mediaUrl; setUrl(mediaUrl) }).catch(() => setUrl(''))
    return () => { if (current.startsWith('blob:')) URL.revokeObjectURL(current) }
  }, [file.path, library.id])
  useEffect(() => {
    if (videoRef.current && url && videoRef.current.readyState >= 1) {
      videoRef.current.currentTime = hit.segments[0]?.start || 0
    }
  }, [url, hit.segments[0]?.start])
  return <div className="video-detail"><video ref={videoRef} src={url} controls playsInline onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = hit.segments[0]?.start || 0 }} /><div className="timeline">{hit.segments.map((segment, index) => <div key={segment.itemId} className={index === 0 ? 'timeline-mark active' : 'timeline-mark'} style={{ left: `${Math.min(96, (segment.start || 0) / (file.duration || 1) * 100)}%` }} />)}</div><div className="timeline-labels"><span>00:00</span><span>{formatTime(file.duration)}</span></div></div>
}

function AudioDetail({ library, file, hit }: { library: Library; file: FileRecord; hit: EnrichedHit }) {
  const [url, setUrl] = useState('')
  const [peaks, setPeaks] = useState<number[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    let current = ''
    void Promise.all([host.mediaUrl(library, file), getThumb(`${library.id}:${file.path}`)]).then(([mediaUrl, thumb]) => {
      current = mediaUrl
      setUrl(mediaUrl)
      setPeaks(thumb?.peaks || [])
    }).catch(() => setUrl(''))
    return () => { if (current.startsWith('blob:')) URL.revokeObjectURL(current) }
  }, [file.path, library.id])
  const seekToHit = () => {
    if (audioRef.current && audioRef.current.readyState >= 1) {
      audioRef.current.currentTime = hit.segments[0]?.start || 0
    }
  }
  useEffect(seekToHit, [url, hit.segments[0]?.start])
  return <div className="audio-detail"><div className="waveform">{(peaks.length ? peaks : Array.from({ length: 120 }, () => 0.22)).map((peak, index) => <i key={index} className={index / 120 >= (hit.segments[0]?.start || 0) / (file.duration || 1) && index / 120 <= (hit.segments[0]?.end || file.duration || 1) / (file.duration || 1) ? 'highlight' : ''} style={{ height: `${Math.max(8, peak * 100)}%` }} />)}</div><audio ref={audioRef} src={url} controls onLoadedMetadata={seekToHit} /></div>
}

export default App
