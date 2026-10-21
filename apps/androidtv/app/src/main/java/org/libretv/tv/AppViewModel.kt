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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import org.libretv.tv.data.AppData
import org.libretv.tv.data.AppSettings
import org.libretv.tv.data.AppStore
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.Defaults
import org.libretv.tv.data.HistoryEntry
import org.libretv.tv.data.LiveChannel
import org.libretv.tv.data.LiveSource
import org.libretv.tv.data.Parsers
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
    ) : Screen
    data class LivePlayer(val channel: LiveChannel) : Screen
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
)

data class CategoryUi(
    val key: CategoryKey = CategoryKey.MOVIE,
    val loading: Boolean = false,
    val groups: List<SearchGroup> = emptyList(),
    val supportedSources: Int = 0,
    val failedSources: Int = 0,
)

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

    private var searchJob: Job? = null

    init {
        viewModelScope.launch {
            seedIfNeeded()
            store.data
                .catch { emit(AppData()) }
                .collect { _data.value = it }
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
            val source = _data.value.sources.firstOrNull { it.key == item.sourceKey }
                ?: VodSource(item.sourceKey, item.sourceName, item.sourceUrl ?: "")
            val result = runCatching { repo.detail(source, item.vodId) }
            detail = result.fold(
                onSuccess = { DetailUi(loading = false, detail = it) },
                onFailure = { DetailUi(loading = false, error = it.message ?: "获取详情失败") },
            )
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
    fun loadLive() {
        val sources = _data.value.activeLiveSources()
        if (sources.isEmpty()) {
            live = live.copy(loading = false)
            showToast("还没有启用任何直播源")
            return
        }
        live = live.copy(loading = true, channels = emptyList(), statuses = emptyList())
        viewModelScope.launch {
            val collected = mutableListOf<LiveChannel>()
            val statuses = mutableListOf<Pair<String, String>>()
            sources.forEach { source ->
                runCatching { repo.liveChannels(source) }
                    .onSuccess { channels ->
                        collected += channels
                        statuses += source.name to "${channels.size} 频道"
                    }
                    .onFailure { statuses += source.name to (it.message ?: "加载失败") }
            }
            live = live.copy(
                loading = false,
                channels = collected,
                statuses = statuses,
                groups = listOf("全部") + Parsers.groups(collected),
            )
        }
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
