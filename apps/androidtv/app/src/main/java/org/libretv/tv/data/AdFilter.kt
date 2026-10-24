package org.libretv.tv.data

/**
 * HLS 播放列表广告分片过滤（与 `packages/core/src/ad-filter.ts` 同规则）。
 *
 * 为什么 TV 端也要自己实现：Media3 直接吃源站的播放列表，没有代理层可以改写，
 * 所以只能在解析阶段把广告分片摘掉。实测 4 个内置源各 8 份播放列表，中插广告
 * 都是「被 #EXT-X-DISCONTINUITY 包起来的 4~5 个分片、约 18~22 秒」，且与正片
 * 同域，所以判定必须靠分段时长与相邻段长度，不能靠 URL。
 */
object AdFilter {
    private const val LEAD_AD_MAX_SECONDS = 90.0
    private const val LEAD_AD_MAX_SEGMENTS = 20
    private const val INTERSTITIAL_MAX_SECONDS = 30.0
    private const val INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120.0

    private val AD_URL = Regex("adjump|advert|/ads?/", RegexOption.IGNORE_CASE)
    private val EXTINF = Regex("^#EXTINF:([\\d.]+)")

    private fun isDisc(line: String) = line.trim() == "#EXT-X-DISCONTINUITY"

    private fun isSegment(line: String): Boolean {
        val t = line.trim()
        return t.isNotEmpty() && !t.startsWith("#")
    }

    private class Group(val start: Int, val end: Int, val discLine: Int, val seconds: Double, val count: Int)

    private fun scanGroups(lines: List<String>): List<Group> {
        val discIdx = lines.indices.filter { isDisc(lines[it]) }
        val bounds = listOf(0) + discIdx + listOf(lines.size)
        val out = ArrayList<Group>()
        for (k in 0 until bounds.size - 1) {
            val start = if (k == 0) 0 else bounds[k] + 1
            val end = bounds[k + 1]
            var seconds = 0.0
            var count = 0
            for (i in start until end) {
                val m = EXTINF.find(lines[i].trim())
                if (m != null) seconds += m.groupValues[1].toDoubleOrNull() ?: 0.0
                else if (isSegment(lines[i])) count += 1
            }
            out += Group(start, end, if (k == 0) -1 else bounds[k], seconds, count)
        }
        return out
    }

    /** 一、URL 里带广告特征的分组整组摘掉 */
    private fun stripMarkedAdGroups(content: String): String {
        if (content.isEmpty()) return ""
        val lines = content.split('\n')
        val drop = BooleanArray(lines.size)
        var i = 0
        while (i < lines.size) {
            if (!isDisc(lines[i])) {
                i += 1
                continue
            }
            var j = i + 1
            var count = 0
            var allAd = true
            while (j < lines.size && !isDisc(lines[j])) {
                if (isSegment(lines[j])) {
                    count += 1
                    if (!AD_URL.containsMatchIn(lines[j].trim())) allAd = false
                }
                j += 1
            }
            if (count > 0 && allAd) {
                drop[i] = true
                for (k in i + 1 until j) {
                    val t = lines[k].trim()
                    if (t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")) continue
                    drop[k] = true
                }
            }
            i = j
        }
        if (!drop.any { it }) return content
        return lines.filterIndexed { idx, _ -> !drop[idx] }.joinToString("\n")
    }

    /** 二、夹在两段长正片之间的超短分组（中插广告的典型形态） */
    internal fun stripInterstitialAdGroups(content: String): String {
        if (content.isEmpty()) return ""
        val lines = content.split('\n')
        val groups = scanGroups(lines)
        val drop = BooleanArray(lines.size)
        for (k in 1 until groups.size) {
            val g = groups[k]
            val prev = groups.getOrNull(k - 1) ?: continue
            val next = groups.getOrNull(k + 1) ?: continue
            if (g.count == 0 || g.discLine < 0) continue
            if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue
            if (prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue
            if (next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue
            drop[g.discLine] = true
            for (i in g.start until g.end) {
                val t = lines[i].trim()
                if (t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")) continue
                drop[i] = true
            }
        }
        if (!drop.any { it }) return content
        return lines.filterIndexed { idx, _ -> !drop[idx] }.joinToString("\n")
    }

    /** 三、片头广告：第一个分片之前有 DISCONTINUITY，且该组不超过 90 秒 / 20 片 */
    internal fun stripLeadAdGroup(content: String): String {
        if (content.isEmpty()) return ""
        val lines = content.split('\n')
        val discIdx = lines.indices.filter { isDisc(lines[it]) }
        if (discIdx.isEmpty()) return content

        // 多分组封装且片头组与其余组同构时，那多半是分片基准，不是广告
        if (discIdx.size >= 4) {
            fun groupSize(from: Int, to: Int) = (from until to).count { isSegment(lines[it]) }
            val leadSize = groupSize(discIdx[0] + 1, discIdx[1])
            val others = (1 until discIdx.size).map { g ->
                groupSize(discIdx[g] + 1, if (g + 1 < discIdx.size) discIdx[g + 1] else lines.size)
            }
            val median = others.sorted()[others.size / 2]
            if (kotlin.math.abs(leadSize - median) <= maxOf(3.0, median * 0.5)) return content
        }

        val firstDisc = discIdx[0]
        if (lines.take(firstDisc).any { isSegment(it) }) return content
        val nextDisc = discIdx.drop(1).firstOrNull { it > firstDisc } ?: return content

        var seconds = 0.0
        var count = 0
        for (i in firstDisc + 1 until nextDisc) {
            val m = EXTINF.find(lines[i].trim())
            if (m != null) seconds += m.groupValues[1].toDoubleOrNull() ?: 0.0
            else if (isSegment(lines[i])) count += 1
        }
        if (count == 0 || count > LEAD_AD_MAX_SEGMENTS) return content
        if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return content

        val kept = lines.filterIndexed { i, l ->
            if (i < firstDisc || i >= nextDisc) true
            else {
                val t = l.trim()
                t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")
            }
        }
        var seenSegment = false
        val out = ArrayList<String>(kept.size)
        for (l in kept) {
            if (!seenSegment && isDisc(l)) continue
            if (isSegment(l)) seenSegment = true
            out += l
        }
        return out.joinToString("\n")
    }

    /** 四、首个分片之前的 DISCONTINUITY 没有语义，清掉免得播放器把整条流当不连续 */
    private fun stripLeadingDisc(content: String): String {
        val lines = content.split('\n')
        val firstSeg = lines.indexOfFirst { isSegment(it) }
        if (firstSeg <= 0) return content
        val kept = lines.filterIndexed { i, l -> !(i < firstSeg && isDisc(l)) }
        return if (kept.size == lines.size) content else kept.joinToString("\n")
    }

    /** 总入口；返回 null 表示「这份列表不需要改」，调用方可以原样放行 */
    fun strip(content: String): String {
        if (content.isEmpty() || !content.contains("#EXTM3U")) return content
        return stripLeadingDisc(
            stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(content)))
        )
    }
}
