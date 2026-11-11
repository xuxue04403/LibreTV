package org.librextv.tv.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** 首页分类入口（与桌面端 packages/core/categories.ts 同一套分类桶） */
enum class CategoryKey(val label: String, val keywords: List<String>) {
    KIDS("少儿", listOf("少儿", "儿童", "亲子", "益智", "儿歌")),
    DOC("纪录片", listOf("纪录片", "记录片", "纪实", "纪录")),
    ANIME("动漫", listOf("动漫", "动画", "番剧", "国漫", "日漫")),
    VARIETY("综艺", listOf("综艺", "真人秀", "脱口秀", "选秀", "晚会")),
    // 后半段是采集站给短剧起的题材名（红牛/百度把它们摆成独立顶级分类，没有父分类可继承）
    SHORT(
        "短剧",
        listOf(
            "短剧", "微短剧", "竖屏剧", "爽文短剧",
            "古装仙侠", "现代都市", "穿越年代", "年代穿越", "言情总裁", "重生民国",
            "反转爽剧", "脑洞悬疑", "AI漫剧", "女频恋爱", "成长逆袭",
        )
    ),
    TV(
        "电视剧",
        listOf(
            "电视剧", "连续剧", "剧集", "国产剧", "港台剧", "日韩剧", "欧美剧", "海外剧",
            "泰剧", "美剧", "韩剧", "日剧",
            // 按地区拆的子分类是真实采集站的标准做法（电影天堂/百度/红牛都有）
            "香港剧", "台湾剧", "韩国剧", "日本剧", "泰国剧", "港澳剧", "大陆剧", "内地剧", "其他剧",
        )
    ),
    SPORTS("体育", listOf("体育", "赛事", "足球", "篮球", "台球", "网球", "斯诺克", "NBA")),
    MOVIE("电影", listOf("电影", "片")),
    OTHER("其他", emptyList());

    companion object {
        /**
         * 首页展示顺序（不含「其他」）。
         *
         * 与判定顺序解耦：`enum` 的声明顺序决定 [Categories.classify] 的短路顺序
         * （专属桶必须排前面，否则「少儿动画」会被「动漫」抢走），
         * 而用户最先想看的是电影和电视剧，所以这里单独定义展示顺序。
         */
        val home: List<CategoryKey> = listOf(MOVIE, TV, KIDS, VARIETY, ANIME, DOC, SHORT, SPORTS)
    }
}

/** 采集站的一条分类 */
data class SourceCategory(val id: String, val name: String, val parentId: String? = null)

/**
 * 分类归并与 type_id 匹配。
 *
 * 与桌面端一致：Apple CMS 的父分类不聚合子分类，必须优先取叶子分类，
 * 否则「电影」分类页会几乎空白。
 */
object Categories {

    fun classify(name: String): CategoryKey {
        val text = name.trim()
        if (text.isEmpty()) return CategoryKey.OTHER
        for (key in CategoryKey.entries) {
            if (key == CategoryKey.OTHER) continue
            if (key.keywords.any { text.contains(it) }) return key
        }
        return CategoryKey.OTHER
    }

    /** 「未分类」「其他」这类桶不跟着父分类混进正经分类 */
    private val INHERIT_BLOCKLIST = setOf("未分类", "其他", "其它", "预告片", "花絮", "待定")

    /**
     * 判定分类属于哪个桶，必要时**继承父分类**。
     *
     * 采集站普遍把题材当子分类挂在「短剧」「体育」「连续剧」下面，名字里不含父级关键词，
     * 只按名字判桶会让这些分类全部落到 OTHER 而不被展示。
     */
    fun bucketOf(category: SourceCategory, byId: Map<String, SourceCategory>): CategoryKey {
        val own = classify(category.name)
        if (own != CategoryKey.OTHER) return own
        if (INHERIT_BLOCKLIST.contains(category.name.trim())) return CategoryKey.OTHER
        val seen = HashSet<String>()
        var parentId = category.parentId
        while (parentId != null && seen.add(parentId)) {
            val parent = byId[parentId] ?: break
            val key = classify(parent.name)
            if (key != CategoryKey.OTHER) return key
            parentId = parent.parentId
        }
        return CategoryKey.OTHER
    }

    fun parse(data: String): List<SourceCategory> {
        val root = runCatching { LooseJson.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return emptyList()
        val raw = (root["class"] ?: root["classes"]) as? JsonArray ?: return emptyList()
        val seen = HashSet<String>()
        val out = mutableListOf<SourceCategory>()
        raw.forEach { element ->
            val obj = element as? JsonObject ?: return@forEach
            val id = (obj.str("type_id") ?: obj.str("typeId") ?: obj.str("id"))?.trim() ?: return@forEach
            val name = (obj.str("type_name") ?: obj.str("typeName") ?: obj.str("name"))?.trim() ?: return@forEach
            if (id.isEmpty() || name.isEmpty() || !seen.add(id)) return@forEach
            val parent = (obj.str("type_pid") ?: obj.str("typePid") ?: obj.str("parent_id"))?.trim()
            out += SourceCategory(id, name, parent?.takeIf { it.isNotEmpty() && it != "0" })
        }
        return out
    }

    /** 某分类桶对应的 type_id 列表：叶子优先，必要时回退父分类 */
    fun typeIds(categories: List<SourceCategory>, key: CategoryKey, limit: Int = 6): List<String> {
        val byId = categories.associateBy { it.id }
        val matched = categories.filter { bucketOf(it, byId) == key }
        if (matched.isEmpty()) return emptyList()

        val childCount = categories.mapNotNull { it.parentId }.groupingBy { it }.eachCount()
        val numeric: (String) -> Long = { id -> id.toLongOrNull() ?: Long.MAX_VALUE }

        val leaves = matched.filter { childCount[it.id] == null }.sortedBy { numeric(it.id) }
        val parents = matched
            .filter { childCount[it.id] != null }
            .filter { parent -> matched.none { it.parentId == parent.id } }
            .sortedBy { numeric(it.id) }

        return (leaves + parents).take(limit.coerceAtLeast(1)).map { it.id }
    }
}
