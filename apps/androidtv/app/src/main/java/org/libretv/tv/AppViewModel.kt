package org.libretv.tv

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.libretv.tv.data.AppData
import org.libretv.tv.data.AppSettings
import org.libretv.tv.data.AppStore
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.Defaults
import org.libretv.tv.data.HistoryEntry
import org.libretv.tv.data.LiveChannel
import org.libretv.tv.data.LiveSource
import org.libretv.tv.data.Parsers
import org.libretv.tv.data.PlaybackCandidate
import org.libretv.tv.data.Repository
import org.libretv.tv.data.SearchGroup
import org.libretv.tv.data.SearchItem
import org.libretv.tv.data.SourceOutcome
import org.libretv.tv.data.VodDetail
import org.libretv.tv.data.VodSource
import java.util.UUID

/** 导航目标：播放页与详情页覆盖在主界面之上 */
sealed interface Screen {
    data object Home : Screen
    data object Search : Screen
    data object Live : Screen
    data object Settings : Screen
    data class Category(val key: CategoryKey) : Screen
    data class Detail(val group: SearchGroup, val item: SearchItem) : Screen
    data class Player(
        val source: VodSource,
        val vodId: String,
        val title: String,
        val cover: String?,
        val episodes: List<String>,
        val startIndex: Int,
        val sourceName: String,
        /** 同片源候选链（含当前源，当前源排第一）；失败时按顺序自动切换 */
        val candidates: List<PlaybackCandidate> = emptyList(),
    ) : Screen
    data class LivePlayer(
        val channel: LiveChannel,
        /**
         * 换台用的频道序列（通常是当前分组+关键词过滤后的可见列表）。
         *
         * 为空时退化成「只播这一个」，遥控器上下键不响应——首页的直播收藏
         * 就是这样进来的：那里没有列表语境，硬换到别的收藏反而不符合预期。
         */
        val playlist: List<LiveChannel> = emptyList(),
    ) : Screen
    data object Cast : Screen
    data class CastPlayer(val url: String, val title: String) : Screen
}

data class SearchUi(
    val keyword: String = "",
    val loading: Boolean = false,
    val outcomes: List<SourceOutcome> = emptyList(),
    val groups: List<SearchGroup> = emptyList(),
    val searched: Boolean = false,
)

data class DetailUi(
    val loading: Boolean = true,
    val detail: VodDetail? = null,
    val error: String? = null,
)

data class LiveUi(
    val loading: Boolean = false,
    val channels: List<LiveChannel> = emptyList(),
    val statuses: List<Pair<String, String>> = emptyList(),
    val groups: List<String> = emptyList(),
    val selectedGroup: String = "全部",
    val keyword: String = "",
    /** 已下载字节数（渐进加载时显示进度，让用户知道正在动而不是卡死） */
    val downloadedBytes: Long = 0,
    /** 命中本地缓存：界面已经可用，后台仍在刷新 */
    val fromCache: Boolean = false,
)

data class CategoryUi(
    val key: CategoryKey = CategoryKey.MOVIE,
    val loading: Boolean = false,
    val groups: List<SearchGroup> = emptyList(),
    val supportedSources: Int = 0,
    val failedSources: Int = 0,
)

/** 单次详情请求的死线：超时即换下一个候选源，不让用户对着转圈等 */
private const val DETAIL_TIMEOUT_MS = 9_000L

/** 同时发起的候选详情请求上限（电视盒子并发能力有限） */
private const val DETAIL_FANOUT = 3

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = AppStore(app)
    private val repo = Repository()

    private val _data = MutableStateFlow(AppData())
    val data: StateFlow<AppData> = _data.asStateFlow()

    var screen by mutableStateOf<Screen>(Screen.Home)
        private set
    var search by mutableStateOf(SearchUi())
        private set
    var detail by mutableStateOf<DetailUi?>(null)
        private set
    var live by mutableStateOf(LiveUi())
        private set
    var category by mutableStateOf(CategoryUi())
        private set
    var toast by mutableStateOf<String?>(null)
        private set
    var importing by mutableStateOf(false)
        private set

    /**
     * 有内容的分类（首页只摆这些入口）。
     * null = 还没探测过（此时先按全量显示，避免布局抖动）。
     */
    var availableCategories by mutableStateOf<List<CategoryKey>?>(null)
        private set
    private var probeJob: Job? = null
    private var probedSourceSignature: String = ""

    private var searchJob: Job? = null

    init {
        viewModelScope.launch {
            seedIfNeeded()
            store.data
                .catch { emit(AppData()) }
                .collect { _data.value = it }
        }
        // 先按上次落盘的结论摆好首页入口，真正的探测由 HomeScreen 触发
        viewModelScope.launch {
            kotlinx.coroutines.delay(300) // 等首帧 seed/collect 落定，拿到 activeSources
            runCatching { restoreCategoryAvailability() }
        }
    }

    // —— 首次启动：导入内置默认源 ——
    private suspend fun seedIfNeeded() {
        val current = store.current()
        if (current.seeded) return
        val (vod, liveSources) = Defaults.load(getApplication())
        store.update {
            it.copy(
                sources = (it.sources + vod).distinctBy { s -> s.url },
                selected = (it.selected + vod.map { s -> s.key }).distinct(),
                liveSources = (it.liveSources + liveSources).distinctBy { s -> s.url },
                liveSelected = (it.liveSelected + liveSources.map { s -> s.key }).distinct(),
                seeded = true,
            )
        }
    }

    // —— 导航 ——
    fun go(target: Screen) {
        screen = target
        if (target is Screen.Search) {
            // 从详情返回搜索时保留结果
        }
        if (target is Screen.Live && live.channels.isEmpty() && !live.loading) {
            loadLive()
        }
        if (target is Screen.Category) {
            loadCategory(target.key)
        }
        if (target is Screen.Cast) {
            // 投屏接收页由 UI 层驱动
        }
    }

    /** 切换分类并重新拉取 */
    fun selectCategory(key: CategoryKey) {
        screen = Screen.Category(key)
        loadCategory(key)
    }

    /**
     * 探测有内容的分类（首页分类入口只显示这些）。
     *
     * 用户反馈「少儿分类无任何影片时应该把入口藏起来」——点进去空页面体验很差。
     * 探测本身要打 8 个分类 × 每个源（约 8 秒），所以结果按源签名落到 DataStore，
     * 下次启动直接按上次结论渲染，后台再刷新，避免首页按钮先全显示再少一个。
     */
    fun probeCategories(force: Boolean = false) {
        val sources = _data.value.activeSources()
        // 源还没就绪（DataStore 首次 collect 之前）时不能下「没有分类」的结论：
        // availableCategories 一旦被写成 emptyList()，首页就会永久停在
        // 「暂未返回任何分类内容」，而接下来真正到达的探测结果会被
        // probedSourceSignature 判重挡掉。这里什么都不做，等源到位后由
        // 首页按源签名重新触发。
        if (sources.isEmpty()) return
        val signature = sources.map { it.key }.sorted().joinToString(",") +
            "|" + _data.value.settings.adultFilter
        if (!force && signature == probedSourceSignature && probeJob?.isActive != true) return
        probedSourceSignature = signature
        probeJob?.cancel()
        probeJob = viewModelScope.launch {
            val hits = runCatching {
                repo.probeCategories(sources, _data.value.settings.adultFilter)
            }.getOrNull()
            val keys = if (hits == null) {
                // 探测整体失败就退回显示全部，不能把入口全藏起来
                CategoryKey.home
            } else {
                CategoryKey.home.filter { (hits[it] ?: 0) > 0 }
            }
            availableCategories = keys
            if (hits != null) store.saveCategoryAvailability(signature, keys.map { it.name })
        }
    }

    /** 启动时先按上次落盘的结论摆好入口（真正的最新结论由 [probeCategories] 覆盖） */
    private suspend fun restoreCategoryAvailability() {
        val sources = _data.value.activeSources()
        if (sources.isEmpty()) return
        val signature = sources.map { it.key }.sorted().joinToString(",") +
            "|" + _data.value.settings.adultFilter
        val cached = store.categoryAvailability(signature) ?: return
        val keys = cached.mapNotNull { name -> CategoryKey.entries.find { it.name == name } }
        // 只用于首屏展示：不写 probedSourceSignature，否则会把后续真实探测挡掉
        if (keys.isNotEmpty()) availableCategories = keys
    }

    /** 记录进入播放页之前的页面，返回时原路退回而不是一律回搜索页 */
    private var backTarget: Screen = Screen.Home

    /** 分类加载任务：切分类时取消上一轮，避免旧结果覆盖新结果 */
    private var categoryJob: Job? = null

    /** 按分类拉取各源内容（分类页与首页分类入口共用） */
    fun loadCategory(key: CategoryKey) {
        val sources = _data.value.activeSources()
        backTarget = Screen.Home
        category = CategoryUi(key = key, loading = sources.isNotEmpty())
        if (sources.isEmpty()) {
            showToast("还没有启用任何点播源")
            return
        }
        // 快速切分类时取消上一轮：否则旧协程回来会覆盖新分类的结果
        categoryJob?.cancel()
        categoryJob = viewModelScope.launch {
            // 并行抓取：串行时单源 14s 超时，8 个源要等近两分钟
            val results = sources.map { source ->
                async { repo.browseCategory(source, key, adultFilter = _data.value.settings.adultFilter) }
            }.awaitAll()
            val items = mutableListOf<SearchItem>()
            var supported = 0
            var failed = 0
            for (result in results) {
                val (ok, list, _) = result
                if (ok) {
                    supported++
                    items += list
                } else {
                    failed++
                }
            }
            category = CategoryUi(
                key = key,
                loading = false,
                groups = Parsers.group(items.distinctBy { "${it.sourceKey}:${it.vodId}" }),
                supportedSources = supported,
                failedSources = failed,
            )
            if (items.isEmpty()) showToast("当前源没有返回「${key.label}」内容")
        }
    }

    fun back() {
        screen = when (val current = screen) {
            is Screen.Player -> {
                saveProgressNow(current)
                // 从分类页/首页/详情进的播放器，应退回原页面而不是搜索页
                when (val origin = backTarget) {
                    is Screen.Detail -> origin
                    is Screen.Category -> origin
                    is Screen.Player, is Screen.CastPlayer, is Screen.LivePlayer -> Screen.Home
                    else -> origin
                }
            }
            is Screen.LivePlayer -> Screen.Live
            is Screen.Detail -> backTarget.takeIf { it is Screen.Category || it is Screen.Search } ?: Screen.Search
            is Screen.Category -> Screen.Home
            is Screen.Cast -> Screen.Home
            is Screen.CastPlayer -> Screen.Home
            else -> Screen.Home
        }
    }

    /** 手机通过 DLNA 投屏过来：直接进入播放页 */
    fun playCast(url: String, title: String) {
        screen = Screen.CastPlayer(url, title)
    }

    fun showToast(message: String) {
        toast = message
    }

    fun consumeToast() {
        toast = null
    }

    // —— 搜索 ——
    fun startSearch(keyword: String) {
        val word = keyword.trim()
        if (word.isEmpty()) return
        searchJob?.cancel()
        search = SearchUi(keyword = word, loading = true, searched = true)
        searchJob = viewModelScope.launch {
            val sources = _data.value.activeSources()
            if (sources.isEmpty()) {
                search = search.copy(loading = false)
                showToast("还没有启用任何点播源，请在设置中添加")
                return@launch
            }
            repo.searchAll(sources, word, _data.value.settings.adultFilter)
                .catch { }
                .collect { outcome ->
                    val outcomes = search.outcomes.filter { it.sourceKey != outcome.sourceKey } + outcome
                    val items = outcomes.filter { it.ok }.flatMap { it.items }
                    search = search.copy(
                        outcomes = outcomes,
                        groups = Parsers.group(items),
                        loading = outcomes.size < sources.size,
                    )
                }
            search = search.copy(loading = false)
        }
    }

    fun openDetail(group: SearchGroup, item: SearchItem) {
        // 记住来源页：详情页与播放页返回时按原路径退回
        if (screen !is Screen.Detail) backTarget = screen
        screen = Screen.Detail(group, item)
        detail = DetailUi(loading = true)
        viewModelScope.launch {
            val sources = _data.value.sources
            val sourceOf: (SearchItem) -> VodSource = { entry ->
                sources.firstOrNull { it.key == entry.sourceKey }
                    ?: VodSource(entry.sourceKey, entry.sourceName, entry.sourceUrl ?: "")
            }

            // 当前源拿不到详情就换同片的其它源：常见于某采集站详情接口挂掉但搜索还活着，
            // 用户看到的是「详情加载失败」，实际上同一部片子别的源完全能播
            val candidates = PlaybackCandidate.build(group.items, sources, active = item.sourceKey to item.vodId)
            val chain = if (candidates.isEmpty()) {
                listOf(PlaybackCandidate(sourceOf(item), item.vodId, item.sourceName))
            } else {
                candidates
            }

            var lastError = "没有可用的片源"
            for (candidate in chain) {
                val target = group.items.firstOrNull {
                    it.sourceKey == candidate.source.key && it.vodId == candidate.vodId
                } ?: item
                val result = withTimeoutOrNull(DETAIL_TIMEOUT_MS) {
                    runCatching { repo.detail(sourceOf(target), target.vodId) }
                }
                val vod = result?.getOrNull()
                if (vod != null && vod.episodes.isNotEmpty()) {
                    if (target !== item) {
                        // 换了源：详情页也要跟着切，否则播放按钮用的还是旧 item
                        screen = Screen.Detail(group, target)
                        showToast("已切换到「${target.sourceName}」")
                    }
                    detail = DetailUi(loading = false, detail = vod)
                    return@launch
                }
                lastError = result?.exceptionOrNull()?.message ?: "「${target.sourceName}」没有可播放的线路"
            }
            detail = DetailUi(loading = false, error = lastError)
        }
    }

    fun playFromDetail(index: Int) {
        val current = screen as? Screen.Detail ?: return
        val vod = detail?.detail ?: return
        val source = _data.value.sources.firstOrNull { it.key == current.item.sourceKey }
            ?: VodSource(current.item.sourceKey, current.item.sourceName, current.item.sourceUrl ?: "")
        screen = Screen.Player(
            source = source,
            vodId = current.item.vodId,
            title = vod.title ?: current.item.name,
            cover = vod.cover ?: current.item.pic,
            episodes = vod.episodes,
            startIndex = index.coerceIn(0, (vod.episodes.size - 1).coerceAtLeast(0)),
            sourceName = current.item.sourceName,
            // 聚合结果里同片源的其它条目就是天然的备份播放源
            candidates = PlaybackCandidate.build(
                items = current.group.items,
                sources = _data.value.sources,
                active = current.item.sourceKey to current.item.vodId,
            ),
        )
    }

    fun resumeFromHistory(entry: HistoryEntry) {
        viewModelScope.launch {
            val source = _data.value.sources.firstOrNull { it.key == entry.sourceKey }
            if (source == null) {
                showToast("该片源已被删除")
                return@launch
            }
            val result = runCatching { repo.detail(source, entry.vodId) }
            result.onSuccess { vod ->
                if (vod.episodes.isEmpty()) {
                    showToast("该片源暂无可用播放地址")
                    return@launch
                }
                screen = Screen.Player(
                    source = source,
                    vodId = entry.vodId,
                    title = vod.title ?: entry.title,
                    cover = vod.cover ?: entry.cover,
                    episodes = vod.episodes,
                    startIndex = entry.episodeIndex.coerceIn(0, vod.episodes.size - 1),
                    sourceName = entry.sourceName,
                    // 历史里只有一个源：先建单元素链，播放页失败时会按片名反查补充
                    candidates = listOf(PlaybackCandidate(source, entry.vodId, entry.sourceName)),
                )
            }.onFailure { showToast(it.message ?: "打开失败") }
        }
    }

    fun playFavorite(favoriteId: String) {
        val entry = _data.value.history.firstOrNull { it.id == favoriteId }
        if (entry != null) {
            resumeFromHistory(entry)
            return
        }
        val fav = _data.value.favorites.firstOrNull { it.id == favoriteId } ?: return
        viewModelScope.launch {
            val source = _data.value.sources.firstOrNull { it.key == fav.sourceKey }
            if (source == null) {
                showToast("该片源已被删除")
                return@launch
            }
            runCatching { repo.detail(source, fav.vodId) }
                .onSuccess { vod ->
                    if (vod.episodes.isEmpty()) {
                        showToast("该片源暂无可用播放地址")
                        return@launch
                    }
                    screen = Screen.Player(
                        source = source,
                        vodId = fav.vodId,
                        title = vod.title ?: fav.title,
                        cover = vod.cover ?: fav.cover,
                        episodes = vod.episodes,
                        startIndex = 0,
                        sourceName = source.name,
                        candidates = listOf(PlaybackCandidate(source, fav.vodId, source.name)),
                    )
                }
                .onFailure { showToast(it.message ?: "打开失败") }
        }
    }

    // —— 观看进度 ——
    fun saveProgress(
        player: Screen.Player,
        index: Int,
        positionMs: Long,
        durationMs: Long,
        finished: Boolean = false,
    ) {
        if (!_data.value.settings.resumePlayback) return
        if (positionMs <= 0) return
        // 看完的一集记为「已完成」，下次续播从头开始；未看完的才记具体位置
        val effectivePosition = if (finished) 0L else positionMs
        val id = "${player.source.key}:${player.vodId}"
        val entry = HistoryEntry(
            id = id,
            sourceKey = player.source.key,
            vodId = player.vodId,
            title = player.title,
            cover = player.cover,
            sourceName = player.sourceName,
            episodeIndex = if (finished) (index + 1).coerceAtMost(player.episodes.size) else index,
            episodeCount = player.episodes.size,
            positionMs = effectivePosition,
            durationMs = durationMs,
            updatedAt = System.currentTimeMillis(),
        )
        viewModelScope.launch {
            store.update { data ->
                data.copy(history = (listOf(entry) + data.history.filter { it.id != id }).take(100))
            }
        }
    }

    private fun saveProgressNow(player: Screen.Player) {
        // 具体位置由播放页在退出前调用 saveProgress 写入
    }

    /**
     * 播放失败时切换到下一个候选源（失败转移）。
     *
     * 候选链试完后，只要还有其它启用的源，就按片名反查一轮补充候选；
     * 补出来的也全部失败才返回 null，避免无限循环。
     * 返回 (新播放目标, 对齐后的集数)，调用方负责用它替换当前播放状态。
     */
    suspend fun failoverPlayback(
        player: Screen.Player,
        tried: Set<String>,
        episodeIndex: Int,
        discovered: Boolean,
    ): FailoverResult? {
        var chain = player.candidates
        var searched = discovered

        while (true) {
            val untried = chain.filter { it.key !in tried }
            if (untried.isEmpty()) {
                if (searched) return null
                searched = true
                val extra = runCatching {
                    repo.discoverCandidates(
                        title = player.title,
                        sources = _data.value.activeSources(),
                        exclude = tried,
                    )
                }.getOrDefault(emptyList())
                if (extra.isEmpty()) return null
                chain = (chain + extra).distinctBy { it.key }
                continue
            }

            val next = untried.first()
            val detail = runCatching { repo.detail(next.source, next.vodId) }.getOrNull()
            if (detail == null || detail.episodes.isEmpty()) continue

            val aligned = episodeIndex.coerceIn(0, (detail.episodes.size - 1).coerceAtLeast(0))
            val target = player.copy(
                source = next.source,
                vodId = next.vodId,
                sourceName = next.sourceName,
                title = detail.title ?: player.title,
                cover = detail.cover ?: player.cover,
                episodes = detail.episodes,
                startIndex = aligned,
                candidates = chain,
            )
            return FailoverResult(target, aligned, next, detail)
        }
    }

    data class FailoverResult(
        val target: Screen.Player,
        val episodeIndex: Int,
        val candidate: PlaybackCandidate,
        val detail: VodDetail,
    )

    fun removeHistory(id: String) {
        viewModelScope.launch { store.update { it.copy(history = it.history.filter { h -> h.id != id }) } }
    }

    fun clearHistory() {
        viewModelScope.launch { store.update { it.copy(history = emptyList()) } }
        showToast("观看历史已清空")
    }

    fun toggleFavorite(item: SearchItem, title: String?, cover: String?) {
        val id = "${item.sourceKey}:${item.vodId}"
        // 是否已收藏要在 update 之前算：update 是异步回写 DataStore，
        // 之后的 _data.value 仍是旧快照，提示语会反掉
        val wasFavorite = _data.value.favorites.any { it.id == id }
        viewModelScope.launch {
            store.update { data ->
                val exists = data.favorites.any { it.id == id }
                if (exists) data.copy(favorites = data.favorites.filter { it.id != id })
                else data.copy(
                    favorites = listOf(
                        org.libretv.tv.data.FavoriteEntry(
                            id = id,
                            sourceKey = item.sourceKey,
                            vodId = item.vodId,
                            title = title ?: item.name,
                            cover = cover ?: item.pic,
                            createdAt = System.currentTimeMillis(),
                        )
                    ) + data.favorites
                )
            }
            showToast(if (wasFavorite) "已取消收藏" else "已收藏")
        }
    }

    // —— 直播 ——

    /** 直播缓存的签名：源地址集合 + 成人过滤开关，任一变化都重拉 */
    private fun liveSignature(sources: List<LiveSource>, adultFilter: Boolean): String =
        sources.map { it.url }.sorted().joinToString("|") + "#" + if (adultFilter) "1" else "0"

    /**
     * 拉取直播频道列表：缓存优先 + 渐进渲染。
     *
     * 实测 iptv-org 的 index.m3u 有 2.46MB、服务器只给 ~35KB/s，整串下载要 70 秒，
     * 而解析只要十几毫秒。原实现是全部下完才赋值，用户要盯着一分钟空列表。
     * 现在三件事同时做：
     * 1. 先读 DataStore 缓存，命中就立刻渲染（进直播页从 70 秒降到 0）；
     * 2. 网络请求边下边解析，每 120 个频道刷新一次列表（第一批约 1 秒上屏）；
     * 3. 全部完成后落盘，下次直接命中。
     */
    fun loadLive(force: Boolean = false) {
        val sources = _data.value.activeLiveSources()
        if (sources.isEmpty()) {
            live = live.copy(loading = false)
            showToast("还没有启用任何直播源")
            return
        }
        if (live.loading) return
        val adultFilter = _data.value.settings.adultFilter
        val signature = liveSignature(sources, adultFilter)
        live = live.copy(loading = true, downloadedBytes = 0)

        viewModelScope.launch {
            // 1) 缓存优先
            if (!force) {
                val cached = runCatching { store.liveCache(signature) }.getOrNull()
                if (!cached.isNullOrEmpty()) {
                    live = live.copy(
                        channels = cached,
                        groups = listOf("全部") + Parsers.groups(cached),
                        statuses = sources.map { s -> s.name to "${cached.count { it.sourceKey == s.key }} 频道" },
                        loading = false,
                        fromCache = true,
                    )
                    // 后台继续刷新，失败就保留缓存（缓存总比空列表有用）
                    refreshLive(sources, adultFilter, signature, quiet = true, progressive = false)
                    return@launch
                }
            }
            refreshLive(sources, adultFilter, signature, quiet = false, progressive = true)
        }
    }

    /**
     * 真正发起网络请求。
     *
     * @param progressive 为 true 时边下边把已解析的频道推给 UI，为 false 时只等最终结果。
     *   已经有缓存列表在屏上时必须传 false：否则界面会先退化成前 120 个频道再长回来，
     *   视觉上像「列表被重置了」。
     */
    private suspend fun refreshLive(
        sources: List<LiveSource>,
        adultFilter: Boolean,
        signature: String,
        quiet: Boolean,
        progressive: Boolean,
    ) {
        // 按源分别累加，合并时按 sources 顺序取，避免频道顺序在每次刷新时乱跳
        val buffers = LinkedHashMap<String, List<LiveChannel>>()
        val mutex = Mutex()
        val done = HashMap<String, String>()
        // 渐进刷新节流：全球列表一万多个频道、每 120 个回调一次，不节流就是
        // 近百次「重算 groups + 整体替换列表」，Compose 重组会明显卡顿。
        // 400ms 足够让首屏一秒内出现，又把工作量压到个位数量级。
        var lastPush = 0L
        val pushIntervalMs = 400L
        val reportProgress = { bytes: Long ->
            live = live.copy(downloadedBytes = bytes)
        }

        coroutineScope {
            sources.forEach { source ->
                launch {
                    var count = 0
                    runCatching {
                        repo.liveChannelsStream(
                            source = source,
                            adultFilter = adultFilter,
                            onBytes = { if (source.key == sources.first().key) reportProgress(it) },
                        ) { batch ->
                            count += batch.size
                            mutex.withLock {
                                buffers[source.key] = (buffers[source.key] ?: emptyList()) + batch
                                val now = System.currentTimeMillis()
                                if (progressive && (lastPush == 0L || now - lastPush >= pushIntervalMs)) {
                                    lastPush = now
                                    val merged = sources.mapNotNull { buffers[it.key] }.flatten()
                                    // loading 保持 true：列表已经在长，但仍需显示"仍在读取"，
                                    // 也让 loadLive 的并发保护继续生效
                                    live = live.copy(
                                        channels = merged,
                                        groups = listOf("全部") + Parsers.groups(merged),
                                    )
                                }
                            }
                        }
                    }
                        .onSuccess { mutex.withLock { done[source.key] = "$count 频道" } }
                        .onFailure { err ->
                            mutex.withLock {
                                done[source.key] =
                                    if (count > 0) "$count 频道（下载中断）"
                                    else (err.message ?: "加载失败")
                            }
                        }
                }
            }
        }

        val merged = sources.mapNotNull { buffers[it.key] }.flatten()
        if (merged.isEmpty()) {
            // 一个频道都没拿到：缓存还在就别清空，只把 loading 摘掉
            live = live.copy(
                loading = false,
                downloadedBytes = 0,
                statuses = sources.map { s -> s.name to (done[s.key] ?: "加载失败") },
            )
            if (!quiet) showToast("所有直播源都没有解析到频道")
            return
        }
        live = live.copy(
            loading = false,
            channels = merged,
            groups = listOf("全部") + Parsers.groups(merged),
            statuses = sources.map { s -> s.name to (done[s.key] ?: "加载失败") },
            downloadedBytes = 0,
            fromCache = false,
        )
        runCatching { store.saveLiveCache(signature, merged) }
    }

    fun setLiveGroup(group: String) {
        live = live.copy(selectedGroup = group)
    }

    fun setLiveKeyword(keyword: String) {
        live = live.copy(keyword = keyword)
    }

    fun toggleLiveFavorite(channel: LiveChannel) {
        viewModelScope.launch {
            store.update { data ->
                val exists = data.liveFavorites.any { it.url == channel.url }
                if (exists) data.copy(liveFavorites = data.liveFavorites.filter { it.url != channel.url })
                else data.copy(
                    liveFavorites = listOf(
                        org.libretv.tv.data.LiveFavoriteEntry(
                            url = channel.url,
                            name = channel.name,
                            logo = channel.logo,
                            createdAt = System.currentTimeMillis(),
                        )
                    ) + data.liveFavorites
                )
            }
        }
    }

    // —— 设置 / 源管理 ——
    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch { store.update { it.copy(settings = transform(it.settings)) } }
    }

    fun addSource(name: String, url: String, detailUrl: String?) {
        val cleanUrl = url.trim().trimEnd('/')
        if (!cleanUrl.startsWith("http")) {
            showToast("请填写 http(s) 开头的采集接口地址")
            return
        }
        val key = "custom_${UUID.randomUUID().toString().take(8)}"
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    sources = data.sources + VodSource(
                        key = key,
                        name = name.ifBlank { runCatching { java.net.URI(cleanUrl).host }.getOrDefault(cleanUrl) },
                        url = cleanUrl,
                        detail = detailUrl?.trim()?.takeIf { it.isNotEmpty() },
                    ),
                    selected = data.selected + key,
                )
            }
            showToast("已添加点播源")
        }
    }

    fun removeSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    sources = data.sources.filter { it.key != key },
                    selected = data.selected - key,
                    history = data.history.filter { it.sourceKey != key },
                    favorites = data.favorites.filter { it.sourceKey != key },
                )
            }
        }
    }

    fun toggleSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    selected = if (key in data.selected) data.selected - key else data.selected + key
                )
            }
        }
    }

    fun addLiveSource(name: String, url: String, epg: String?) {
        val cleanUrl = url.trim().trimEnd('/')
        if (!cleanUrl.startsWith("http")) {
            showToast("请填写 http(s) 开头的 M3U 地址")
            return
        }
        val key = "live_${UUID.randomUUID().toString().take(8)}"
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    liveSources = data.liveSources + LiveSource(
                        key = key,
                        name = name.ifBlank { runCatching { java.net.URI(cleanUrl).host }.getOrDefault(cleanUrl) },
                        url = cleanUrl,
                        epg = epg?.trim()?.takeIf { it.isNotEmpty() },
                    ),
                    liveSelected = data.liveSelected + key,
                )
            }
            showToast("已添加直播源")
        }
    }

    fun removeLiveSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    liveSources = data.liveSources.filter { it.key != key },
                    liveSelected = data.liveSelected - key,
                )
            }
        }
    }

    fun toggleLiveSource(key: String) {
        viewModelScope.launch {
            store.update { data ->
                data.copy(
                    liveSelected = if (key in data.liveSelected) data.liveSelected - key else data.liveSelected + key
                )
            }
        }
    }

    fun importSubscription(url: String) {
        val trimmed = url.trim()
        if (!trimmed.startsWith("http")) {
            showToast("请填写订阅地址")
            return
        }
        importing = true
        viewModelScope.launch {
            runCatching { repo.importSubscription(trimmed) }
                .onSuccess { parsed ->
                    store.update { data ->
                        val vod = parsed.sources.filter { s -> data.sources.none { it.url == s.url } }
                        val lives = parsed.liveSources.filter { s -> data.liveSources.none { it.url == s.url } }
                        data.copy(
                            sources = data.sources + vod,
                            selected = (data.selected + vod.map { it.key }).distinct(),
                            liveSources = data.liveSources + lives,
                            liveSelected = (data.liveSelected + lives.map { it.key }).distinct(),
                        )
                    }
                    showToast("已导入 ${parsed.sources.size} 个点播源、${parsed.liveSources.size} 个直播源")
                }
                .onFailure { showToast(it.message ?: "导入失败") }
            importing = false
        }
    }

    fun restoreBuiltinSources() {
        viewModelScope.launch {
            val (vod, lives) = Defaults.load(getApplication())
            store.update { data ->
                val newVod = vod.filter { s -> data.sources.none { it.url == s.url } }
                val newLive = lives.filter { s -> data.liveSources.none { it.url == s.url } }
                data.copy(
                    sources = data.sources + newVod,
                    selected = (data.selected + newVod.map { it.key }).distinct(),
                    liveSources = data.liveSources + newLive,
                    liveSelected = (data.liveSelected + newLive.map { it.key }).distinct(),
                )
            }
            showToast("已恢复内置默认源")
        }
    }
}
