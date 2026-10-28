package org.libretv.tv.data

import android.content.Context
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** 读取打包进 assets 的默认源清单（与仓库 defaults/sources.json 同一份内容） */
object Defaults {
    /**
     * 内置源清单的版本号（`defaults/sources.json` 的 `version`）。
     *
     * 加新内置源时必须同时把这个数字加一，否则老用户的 `seeded` 已经是 true，
     * 后续新增的源永远补不进来。
     */
    fun version(context: Context): Int {
        val text = runCatching {
            context.assets.open("default-sources.json").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return 0
        val root = runCatching { LooseJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return 0
        return root.str("version")?.trim()?.toIntOrNull() ?: 0
    }

    fun load(context: Context): Pair<List<VodSource>, List<LiveSource>> {
        val text = runCatching {
            context.assets.open("default-sources.json").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return emptyList<VodSource>() to emptyList()

        val root = runCatching { LooseJson.parseToJsonElement(text).jsonObject }.getOrNull()
            ?: return emptyList<VodSource>() to emptyList()

        val vod = (root["sources"] as? JsonArray)?.mapIndexedNotNull { index, element ->
            val obj = element as? JsonObject ?: return@mapIndexedNotNull null
            val url = obj.str("url")?.trimEnd('/') ?: return@mapIndexedNotNull null
            if (!url.startsWith("http")) return@mapIndexedNotNull null
            VodSource(
                key = "builtin_$index",
                name = obj.str("name") ?: url,
                url = url,
                detail = obj.str("detail"),
                builtin = true,
            )
        }.orEmpty()

        val live = (root["liveSources"] as? JsonArray)?.mapIndexedNotNull { index, element ->
            val obj = element as? JsonObject ?: return@mapIndexedNotNull null
            val url = obj.str("url")?.trimEnd('/') ?: return@mapIndexedNotNull null
            if (!url.startsWith("http")) return@mapIndexedNotNull null
            LiveSource(
                key = "builtin_live_$index",
                name = obj.str("name") ?: url,
                url = url,
                epg = obj.str("epg"),
                builtin = true,
                note = obj.str("note"),
            )
        }.orEmpty()

        return vod to live
    }

    /**
     * 新装用户默认启用的内置直播源 key。
     *
     * 两个 iptv-org 源实测可播率太低（全球榜一万多个频道绝大多数境内打不开，中国榜
     * 138 个里只有 66 个能开），默认启用它们只会让用户随手点一个台就是死台。清单里
     * 用 `"selected": false` 标出来：源照样进列表，只是默认不勾选。默认启用的只有
     * Collect-IPTV 精选（实测 94% 可播）。
     */
    fun defaultLiveSelectedKeys(context: Context): Set<String> =
        defaultLiveSelectedKeysFrom(assetText(context))

    /** [defaultLiveSelectedKeys] 的纯函数版本，方便单测（不依赖 Android Context） */
    fun defaultLiveSelectedKeysFrom(text: String): Set<String> {
        val root = runCatching { LooseJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return emptySet()
        val array = root["liveSources"] as? JsonArray ?: return emptySet()
        return array.mapIndexedNotNull { index, element ->
            val obj = element as? JsonObject ?: return@mapIndexedNotNull null
            // 只有明确写了 selected:false 的才关掉，缺省仍然是启用
            if (obj["selected"]?.toString()?.trim()?.trim('"') == "false") return@mapIndexedNotNull null
            "builtin_live_$index"
        }.toSet()
    }

    /** 清单里明确标了 `selected: false` 的内置直播源 key */
    fun defaultLiveDisabledKeys(context: Context): Set<String> =
        defaultLiveDisabledKeysFrom(assetText(context))

    /** [defaultLiveDisabledKeys] 的纯函数版本 */
    fun defaultLiveDisabledKeysFrom(text: String): Set<String> {
        val root = runCatching { LooseJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return emptySet()
        val array = root["liveSources"] as? JsonArray ?: return emptySet()
        return array.mapIndexedNotNull { index, element ->
            val obj = element as? JsonObject ?: return@mapIndexedNotNull null
            if (obj["selected"]?.toString()?.trim()?.trim('"') != "false") return@mapIndexedNotNull null
            "builtin_live_$index"
        }.toSet()
    }

    private fun assetText(context: Context): String = runCatching {
        context.assets.open("default-sources.json").bufferedReader().use { it.readText() }
    }.getOrNull() ?: ""

    /**
     * 从哪个清单版本开始「只默认启用健康源」。
     *
     * 到 v4 为止老用户是三个直播源全开的，只改 `selected` 对他们没效果（勾选状态
     * 早就存进 `liveSelected` 了），所以升级到该版本时取消勾选一次。只做这一次：
     * 用户之后手动打开的，不会在下次升级时又被关掉。
     */
    const val LIVE_SELECTION_VERSION = 5
}
