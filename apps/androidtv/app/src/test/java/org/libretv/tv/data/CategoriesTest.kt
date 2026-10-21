package org.libretv.tv.data

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
    fun `首页分类不含其他且顺序固定`() {
        assertEquals(
            listOf("少儿", "纪录片", "动漫", "综艺", "短剧", "电视剧", "体育", "电影"),
            CategoryKey.home.map { it.label },
        )
    }
}
