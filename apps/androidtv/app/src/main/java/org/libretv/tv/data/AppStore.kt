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
}
