package org.libretv.tv.data

/**
 * 观看记录的去重规则。
 *
 * 记录 id 是「源 key + vodId」，只按 id 去重的话，同一部片子从两个采集源各播一次
 * 就会在首页「继续观看」里留两条同名卡片。这里改成按**片名 + 年份**去重
 * （片名归一化后比较，忽略空格/标点/大小写），与桌面端
 * `packages/core/src/storage.ts` 的 `historyGroupKey` / `isSameWork` 语义一致。
 *
 * 为什么必须带年份：`西游记`、`射雕英雄传` 这类片名在采集站有多个年份的版本，
 * 只按片名合并会把用户另一部剧的记录直接删掉。任一方没有年份（升级前的老记录）
 * 就退回按片名比较，避免同一次播放产生「带年份」「不带年份」两条记录。
 */
object HistoryDedupe {

    /** 两条记录是否属于同一部片子（片名相同且年份不冲突） */
    fun sameWork(
        a: HistoryEntry,
        title: String,
        year: String?,
    ): Boolean {
        if (Parsers.normalizeTitle(a.title) != Parsers.normalizeTitle(title)) return false
        val ay = a.year?.trim().orEmpty()
        val by = year?.trim().orEmpty()
        if (ay.isEmpty() || by.isEmpty()) return true
        return ay == by
    }

    /**
     * 按出现顺序去重，保留每部片子的第一条（调用方传入的列表是新到旧的顺序）。
     *
     * 幂等：对已去重的列表再调一次结果不变。
     */
    fun dedupe(list: List<HistoryEntry>): List<HistoryEntry> {
        val kept = ArrayList<HistoryEntry>(list.size)
        for (entry in list) {
            if (kept.any { sameWork(it, entry.title, entry.year) }) continue
            kept.add(entry)
        }
        return kept
    }

    /**
     * 顶置一条新记录：同一部片子（含跨源）的旧记录全部被替换掉。
     *
     * [limit] 为保留上限，默认与 [AppStore] 落盘的上限一致。
     */
    fun upsert(list: List<HistoryEntry>, entry: HistoryEntry, limit: Int = 100): List<HistoryEntry> {
        val rest = list.filter { it.id != entry.id && !sameWork(it, entry.title, entry.year) }
        return (listOf(entry) + rest).take(limit)
    }
}
