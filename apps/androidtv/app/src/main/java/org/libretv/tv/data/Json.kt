package org.libretv.tv.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 采集站返回的 JSON 常常带多余字段，统一用宽松解析 */
val LooseJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
}

fun JsonElement?.asStringOrNull(): String? {
    if (this == null || this is JsonNull) return null
    return runCatching { jsonPrimitive.content }.getOrNull()?.takeIf { it.isNotBlank() }
}

fun JsonObject.str(key: String): String? = this[key].asStringOrNull()

fun JsonObject.arr(key: String): JsonArray? = (this[key] as? JsonArray)
