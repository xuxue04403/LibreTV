package org.libretv.tv.data

/**
 * 观看记录的去重规则。
 *
 * 记录 id 是「源 key + vodId」，只按 id 去重的话，同一部片子从两个采集源各播一次
 * 就会在首页「继续观看」里留两条同名卡片。这里改成按**片名**去重
 * （归一化后比较，忽略空格/标点/大小写），与桌面端 `packages/core/src/storage.ts`
 * 的 `historyGroupKey` 语义一致。
 */
object HistoryDedupe {

    /** 两条记录是否属于同一部片子（按归一化片名） */
    fun sameTitle(a: String, b: String): Boolean =
        Parsers.normalizeTitle(a) == Parsers.normalizeTitle(b)

    /**
     * 按出现顺序去重，保留每个片名的第一条（调用方传入的列表是新到旧的顺序）。
     *
     * 幂等：对已去重的列表再调一次结果不变。
     */
    fun dedupe(list: List<HistoryEntry>): List<HistoryEntry> {
        val seen = HashSet<String>()
        return list.filter { seen.add(Parsers.normalizeTitle(it.title)) }
    }

    /**
     * 顶置一条新记录：同片名（含跨源）的旧记录全部被替换掉。
     *
     * [limit] 为保留上限，默认与 [AppStore] 落盘的上限一致。
     */
    fun upsert(list: List<HistoryEntry>, entry: HistoryEntry, limit: Int = 100): List<HistoryEntry> {
        val key = Parsers.normalizeTitle(entry.title)
        return (listOf(entry) + list.filter {
            it.id != entry.id && Parsers.normalizeTitle(it.title) != key
        }).take(limit)
    }
}
