package org.librextv.tv.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

private val Context.appDataStore: DataStore<Preferences> by preferencesDataStore(name = "librextv")

/**
 * 本地状态存储：整个 AppData 以一份 JSON 存在 DataStore 里。
 *
 * 相比上游用 IndexedDB + 多个 localStorage key，这里把源、历史、收藏、设置
 * 收敛成单一快照，读写都是原子的，也方便导出/迁移到桌面端。
 */
class AppStore(private val context: Context) {
    private val key = stringPreferencesKey("app-data")
    private val corruptKey = stringPreferencesKey("app-data-corrupt")
    private val availabilityKey = stringPreferencesKey("category-availability")
    private val liveCacheKey = stringPreferencesKey("live-cache")
    private val pinyinIndexKey = stringPreferencesKey("pinyin-index")
    private val catalogKey = stringPreferencesKey("catalog-cache")
    private val searchCacheKey = stringPreferencesKey("search-cache")

    /** 最近一次成功解析的快照：解析失败时先拿它顶着，别让界面瞬间变空 */
    @Volatile
    private var lastGood: AppData? = null

    /** 解析失败时把原文另存一份，供事后排查（也避免下一次写入把它彻底盖掉） */
    @Volatile
    var lastDecodeError: String? = null
        private set

    val data: Flow<AppData> = context.appDataStore.data.map { prefs -> decodeOrLastGood(prefs[key]) }

    /** 原始解析：区分「没有数据」与「数据坏了」——前者返回默认值，后者返回 null */
    private fun decodeOrNull(raw: String?): AppData? {
        if (raw.isNullOrBlank()) return AppData()
        return runCatching { LooseJson.decodeFromString<AppData>(raw) }
            .onFailure { lastDecodeError = it.message }
            .getOrNull()
    }

    private fun decodeOrLastGood(raw: String?): AppData {
        val decoded = decodeOrNull(raw)
        if (decoded != null) {
            lastGood = decoded
            return decoded
        }
        return lastGood ?: AppData()
    }

    suspend fun current(): AppData = decodeOrNull(context.appDataStore.data.first()[key]) ?: AppData()

    /**
     * 原子读改写。返回 false 表示「本地快照解析失败、这次写入被跳过」。
     *
     * 调用方大多是「存进度」这类后台写入，拿不到 true 也不该崩，
     * 所以这里不抛异常；真正要让用户知道时再看返回值。
     */
    suspend fun update(transform: (AppData) -> AppData): Boolean {
        var blocked = false
        context.appDataStore.edit { prefs ->
            val raw = prefs[key]
            val decoded = decodeOrNull(raw)
            if (decoded == null) {
                // 快照解析失败时绝不能按「空数据」继续写：
                // update 的读改写会把源、历史、收藏一次性清空（这是最伤的一种数据丢失）。
                // 先把坏数据另存一份，然后放弃这次写入。
                if (!raw.isNullOrBlank()) prefs[corruptKey] = raw
                blocked = true
                return@edit
            }
            prefs[key] = LooseJson.encodeToString(transform(decoded))
        }
        return !blocked
    }

    suspend fun replace(data: AppData) {
        context.appDataStore.edit { prefs ->
            prefs[key] = LooseJson.encodeToString(data)
        }
    }

    /**
     * 分类可用性缓存，格式 `源签名\tk1,k2,k3`。
     *
     * 探测要打 8 个分类 × 每个源（约 8 秒），冷启动时先按上次结论渲染，
     * 避免首页入口「先全显示、再消失一个」的抖动。
     */
    suspend fun categoryAvailability(signature: String): List<String>? {
        val raw = context.appDataStore.data.first()[availabilityKey] ?: return null
        val sep = raw.indexOf('\t')
        if (sep <= 0) return null
        if (raw.substring(0, sep) != signature) return null
        val tail = raw.substring(sep + 1)
        return if (tail.isBlank()) emptyList() else tail.split(',')
    }

    suspend fun saveCategoryAvailability(signature: String, keys: List<String>) {
        context.appDataStore.edit { prefs ->
            prefs[availabilityKey] = signature + "\t" + keys.joinToString(",")
        }
    }

    /**
     * 直播频道列表缓存。
     *
     * iptv-org 的 index.m3u 有 2.46MB、服务器限速到 ~35KB/s，整串下载要 70 秒。
     * 频道列表一天内基本不变，缓存 6 小时就能把「进直播页」从一分钟降到 0。
     * 格式 `签名\t时间戳\tJSON`，独立 key 存放，不和 app-data 的原子写抢。
     */
    suspend fun liveCache(signature: String): List<LiveChannel>? {
        val raw = context.appDataStore.data.first()[liveCacheKey] ?: return null
        val sep = raw.indexOf('\t')
        if (sep <= 0) return null
        if (raw.substring(0, sep) != signature) return null
        val second = raw.indexOf('\t', sep + 1)
        if (second <= sep + 1) return null
        val stamp = raw.substring(sep + 1, second).toLongOrNull() ?: return null
        if (System.currentTimeMillis() - stamp > 6 * 60 * 60 * 1000L) return null
        val body = raw.substring(second + 1)
        if (body.isEmpty()) return emptyList()
        return runCatching {
            LooseJson.decodeFromString<List<CachedChannel>>(body).map { it.toChannel() }
        }.getOrNull()
    }

    suspend fun saveLiveCache(signature: String, channels: List<LiveChannel>) {
        val now = System.currentTimeMillis().toString()
        val body = runCatching {
            LooseJson.encodeToString(channels.map { CachedChannel.from(it) })
        }.getOrNull() ?: return
        context.appDataStore.edit { prefs ->
            prefs[liveCacheKey] = "$signature\t$now\t$body"
        }
    }

    suspend fun clearLiveCache() {
        context.appDataStore.edit { prefs -> prefs.remove(liveCacheKey) }
    }

    /**
     * 拼音检索的本地索引。
     *
     * 采集站的 `wd` 只认中文，拼音只能拿「已经见过的片名」反查：浏览过分类、
     * 搜过片名，这些条目的首字母就有据可查。索引落盘后，第二次输入 `qmmk`
     * 不用等网络。上限 [PINYIN_INDEX_LIMIT] 条，超出时**保留最新的那些**
     * （Repository.seenSnapshot 按插入顺序给出，最近的在后）。
     */
    suspend fun pinyinIndex(): List<SearchItem> {
        val raw = context.appDataStore.data.first()[pinyinIndexKey] ?: return emptyList()
        return runCatching {
            LooseJson.decodeFromString<List<IndexEntry>>(raw).map { it.toItem() }
        }.getOrDefault(emptyList())
    }

    suspend fun savePinyinIndex(items: List<SearchItem>) {
        if (items.isEmpty()) return
        // takeLast 而不是 take：调用方给的是「老 → 新」顺序，
        // 截断时丢掉老条目才符合「新的在前」的语义（之前 take 丢的是最新的）。
        val body = runCatching {
            LooseJson.encodeToString(items.takeLast(PINYIN_INDEX_LIMIT).map { IndexEntry.from(it) })
        }.getOrNull() ?: return
        context.appDataStore.edit { prefs -> prefs[pinyinIndexKey] = body }
    }

    /**
     * 分类目录落盘缓存。
     *
     * 与 `live-cache` 同样的思路：单独一个 key，不和 app-data 的原子读改写抢。
     * 源集合签名不符就整体作废——换过源之后，旧条目可能来自已经被停用的站。
     */
    suspend fun catalog(signature: String): CatalogSnapshot? {
        val raw = context.appDataStore.data.first()[catalogKey] ?: return null
        val snapshot = runCatching { LooseJson.decodeFromString<CatalogSnapshot>(raw) }.getOrNull()
            ?: return null
        return snapshot.takeIf { it.signature == signature }
    }

    suspend fun saveCatalog(snapshot: CatalogSnapshot) {
        val body = runCatching { LooseJson.encodeToString(snapshot) }.getOrNull() ?: return
        context.appDataStore.edit { prefs -> prefs[catalogKey] = body }
    }

    suspend fun clearCatalog() {
        context.appDataStore.edit { prefs -> prefs.remove(catalogKey) }
    }

    /** 检索结果缓存（1 小时，最多 20 个关键词） */
    suspend fun searchCache(signature: String): SearchCacheSnapshot? {
        val raw = context.appDataStore.data.first()[searchCacheKey] ?: return null
        val sep = raw.indexOf('\t')
        if (sep <= 0) return null
        if (raw.substring(0, sep) != signature) return null
        return runCatching {
            LooseJson.decodeFromString<SearchCacheSnapshot>(raw.substring(sep + 1))
        }.getOrNull()
    }

    suspend fun saveSearchCache(signature: String, snapshot: SearchCacheSnapshot) {
        val body = runCatching { LooseJson.encodeToString(snapshot) }.getOrNull() ?: return
        context.appDataStore.edit { prefs -> prefs[searchCacheKey] = "$signature\t$body" }
    }
}

/**
 * 拼音索引上限。
 *
 * 索引越大，首字母检索能命中的老片越多；每条压缩后约 60-80 字节，
 * 12000 条落盘约 1MB，DataStore 读一次几十毫秒，可以接受。
 */
private const val PINYIN_INDEX_LIMIT = 12000

/** 拼音索引里的一行：字段都取短名，一万条也就几百 KB */
@Serializable
private data class IndexEntry(
    val n: String,
    val sk: String,
    val sn: String,
    val v: String,
    val p: String? = null,
    val t: String? = null,
    val y: String? = null,
    val a: String? = null,
) {
    fun toItem() = SearchItem(
        sourceKey = sk,
        sourceName = sn,
        vodId = v,
        name = n,
        pic = p,
        typeName = t,
        year = y,
        area = a,
    )

    companion object {
        fun from(item: SearchItem) = IndexEntry(
            n = item.name,
            sk = item.sourceKey,
            sn = item.sourceName,
            v = item.vodId,
            p = item.pic,
            t = item.typeName,
            y = item.year,
            a = item.area,
        )


    }
}

/** 缓存用的精简频道：只存原始字段，反序列化后按同一规则重新派生 id */
@Serializable
private data class CachedChannel(
    val n: String,
    val u: String,
    val l: String? = null,
    val g: String? = null,
    val t: String? = null,
    val sk: String = "",
    val sn: String = "",
) {
    fun toChannel(): LiveChannel = LiveChannel(
        id = t ?: Parsers.stableId(u),
        name = n,
        url = u,
        logo = l,
        group = g,
        tvgId = t,
        sourceKey = sk,
        sourceName = sn,
    )

    companion object {
        fun from(ch: LiveChannel): CachedChannel = CachedChannel(
            n = ch.name,
            u = ch.url,
            l = ch.logo,
            g = ch.group,
            t = ch.tvgId,
            sk = ch.sourceKey,
            sn = ch.sourceName,
        )
    }
}
