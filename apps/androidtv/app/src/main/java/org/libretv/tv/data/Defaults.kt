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
            )
        }.orEmpty()

        return vod to live
    }
}
