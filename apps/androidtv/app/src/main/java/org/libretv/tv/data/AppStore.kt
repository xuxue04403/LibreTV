package org.libretv.tv.data

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

private val Context.appDataStore: DataStore<Preferences> by preferencesDataStore(name = "libretv")

/**
 * 本地状态存储：整个 AppData 以一份 JSON 存在 DataStore 里。
 *
 * 相比上游用 IndexedDB + 多个 localStorage key，这里把源、历史、收藏、设置
 * 收敛成单一快照，读写都是原子的，也方便导出/迁移到桌面端。
 */
class AppStore(private val context: Context) {
    private val key = stringPreferencesKey("app-data")
    private val availabilityKey = stringPreferencesKey("category-availability")
    private val liveCacheKey = stringPreferencesKey("live-cache")

    val data: Flow<AppData> = context.appDataStore.data.map { prefs -> decode(prefs[key]) }

    private fun decode(raw: String?): AppData {
        if (raw.isNullOrBlank()) return AppData()
        return runCatching { LooseJson.decodeFromString<AppData>(raw) }.getOrDefault(AppData())
    }

    suspend fun current(): AppData = decode(context.appDataStore.data.first()[key])

    suspend fun update(transform: (AppData) -> AppData) {
        context.appDataStore.edit { prefs ->
            val current = decode(prefs[key])
            prefs[key] = LooseJson.encodeToString(transform(current))
        }
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
