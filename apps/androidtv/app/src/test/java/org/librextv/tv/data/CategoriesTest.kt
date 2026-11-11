package org.librextv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 分类归并与 type_id 匹配的 JVM 单测（与桌面端 categories.test.ts 对应） */
class CategoriesTest {

    private val lziapi = listOf(
        SourceCategory("1", "电影片", null),
        SourceCategory("2", "连续剧", null),
        SourceCategory("3", "综艺片", null),
        SourceCategory("4", "动漫片", null),
        SourceCategory("6", "动作片", "1"),
        SourceCategory("7", "喜剧片", "1"),
        SourceCategory("13", "国产剧", "2"),
        SourceCategory("20", "记录片", "1"),
        SourceCategory("25", "大陆综艺", "3"),
        SourceCategory("29", "国产动漫", "4"),
        SourceCategory("36", "体育", null),
        SourceCategory("46", "短剧", null),
        SourceCategory("5", "少儿", null),
    )

    @Test
    fun `分类名称归类`() {
        assertEquals(CategoryKey.MOVIE, Categories.classify("电影"))
        assertEquals(CategoryKey.MOVIE, Categories.classify("动作片"))
        assertEquals(CategoryKey.TV, Categories.classify("连续剧"))
        assertEquals(CategoryKey.VARIETY, Categories.classify("综艺片"))
        assertEquals(CategoryKey.ANIME, Categories.classify("动漫片"))
        assertEquals(CategoryKey.KIDS, Categories.classify("少儿"))
        assertEquals(CategoryKey.DOC, Categories.classify("记录片"))
        assertEquals(CategoryKey.SHORT, Categories.classify("短剧"))
        assertEquals(CategoryKey.SPORTS, Categories.classify("体育"))
        assertEquals(CategoryKey.OTHER, Categories.classify("福利"))
    }

    @Test
    fun `专属桶优先`() {
        assertEquals(CategoryKey.KIDS, Categories.classify("少儿动画"))
        assertEquals(CategoryKey.DOC, Categories.classify("纪录电影"))
    }

    @Test
    fun `解析 class 数组`() {
        val json = """{"class":[{"type_id":1,"type_name":"电影片","type_pid":0},{"type_id":6,"type_name":"动作片","type_pid":1}]}"""
        val categories = Categories.parse(json)
        assertEquals(2, categories.size)
        assertEquals("1", categories[0].id)
        assertEquals(null, categories[0].parentId)
        assertEquals("1", categories[1].parentId)
        assertTrue(Categories.parse("{}").isEmpty())
    }

    @Test
    fun `父分类不聚合子分类时优先取叶子`() {
        val movieIds = Categories.typeIds(lziapi, CategoryKey.MOVIE)
        // 动作片/喜剧片是叶子；「电影片」有子分类被排除；记录片归入纪录片桶
        assertEquals(listOf("6", "7"), movieIds)
    }

    @Test
    fun `电视剧取子分类`() {
        assertEquals(listOf("13"), Categories.typeIds(lziapi, CategoryKey.TV))
    }

    @Test
    fun `只有顶级分类时回退父分类`() {
        val simple = listOf(SourceCategory("1", "电影", null))
        assertEquals(listOf("1"), Categories.typeIds(simple, CategoryKey.MOVIE))
    }

    @Test
    fun `没有对应分类返回空`() {
        assertTrue(Categories.typeIds(lziapi, CategoryKey.OTHER).isEmpty())
        assertTrue(Categories.typeIds(emptyList(), CategoryKey.MOVIE).isEmpty())
    }

    @Test
    fun `首页分类不含其他，且电影电视剧排最前`() {
        assertEquals(
            listOf("电影", "电视剧", "少儿", "综艺", "动漫", "纪录片", "短剧", "体育"),
            CategoryKey.home.map { it.label },
        )
        // 展示顺序与判定顺序解耦：enum 声明顺序仍让专属桶先短路
        assertEquals(CategoryKey.KIDS, Categories.classify("少儿动画"))
        assertEquals(CategoryKey.DOC, Categories.classify("纪录电影"))
    }

    @Test
    fun `名字判不出时继承父分类`() {
        // 真实采集站（极速/红牛）把短剧题材当子分类挂在「短剧」下
        val shortTree = listOf(
            SourceCategory("38", "短剧", null),
            SourceCategory("45", "古装仙侠", "38"),
            SourceCategory("46", "现代都市", "38"),
            SourceCategory("54", "AI漫剧", "38"),
        )
        val byId = shortTree.associateBy { it.id }
        for (id in listOf("45", "46", "54")) {
            assertEquals(id, CategoryKey.SHORT, Categories.bucketOf(byId.getValue(id), byId))
        }
        assertEquals(listOf("45", "46", "54"), Categories.typeIds(shortTree, CategoryKey.SHORT))

        val sportsTree = listOf(
            SourceCategory("29", "体育赛事", null),
            SourceCategory("42", "台球", "29"),
        )
        val sportsById = sportsTree.associateBy { it.id }
        assertEquals(CategoryKey.SPORTS, Categories.bucketOf(sportsById.getValue("42"), sportsById))
    }

    @Test
    fun `名字判得出时不被父分类覆盖`() {
        val tree = listOf(
            SourceCategory("1", "电影片", null),
            SourceCategory("20", "记录片", "1"),
        )
        val byId = tree.associateBy { it.id }
        // 「记录片」挂在电影下，但它是纪录片
        assertEquals(CategoryKey.DOC, Categories.bucketOf(byId.getValue("20"), byId))
    }

    @Test
    fun `兜底分类不跟着父分类混进正经桶`() {
        val tree = listOf(
            SourceCategory("1", "电影", null),
            SourceCategory("43", "未分类", "1"),
        )
        val byId = tree.associateBy { it.id }
        assertEquals(CategoryKey.OTHER, Categories.bucketOf(byId.getValue("43"), byId))
    }

    @Test
    fun `父级缺失或成环时安全返回其他`() {
        val orphan = SourceCategory("9", "神秘分类", "999")
        assertEquals(CategoryKey.OTHER, Categories.bucketOf(orphan, mapOf("9" to orphan)))

        val a = SourceCategory("a", "环甲", "b")
        val b = SourceCategory("b", "环乙", "a")
        assertEquals(CategoryKey.OTHER, Categories.bucketOf(a, mapOf("a" to a, "b" to b)))
    }

    @Test
    fun `按地区拆的剧集与赛事题材直接归桶`() {
        for (name in listOf("香港剧", "台湾剧", "韩国剧", "日本剧", "泰国剧", "港澳剧", "大陆剧")) {
            assertEquals(name, CategoryKey.TV, Categories.classify(name))
        }
        for (name in listOf("台球", "网球", "斯诺克", "NBA")) {
            assertEquals(name, CategoryKey.SPORTS, Categories.classify(name))
        }
        for (name in listOf("古装仙侠", "现代都市", "反转爽剧", "AI漫剧", "女频恋爱")) {
            assertEquals(name, CategoryKey.SHORT, Categories.classify(name))
        }
        assertEquals(CategoryKey.SHORT, Categories.classify("爽文短剧"))
    }
}
