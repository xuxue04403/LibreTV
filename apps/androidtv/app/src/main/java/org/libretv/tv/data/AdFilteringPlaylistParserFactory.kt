package org.libretv.tv.data

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylistParser
import androidx.media3.exoplayer.hls.playlist.HlsPlaylistParserFactory
import androidx.media3.exoplayer.upstream.ParsingLoadable
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * 把「广告分片过滤」插到 Media3 的播放列表解析里。
 *
 * 桌面端是在回环代理里改写 m3u8；TV 端没有代理层，但 Media3 允许替换播放列表解析器，
 * 于是这里把整份文本读出来、交给 [AdFilter] 摘掉中插广告分组，再让官方解析器照常解析。
 *
 * 只处理媒体播放列表（含 `#EXTINF`）：多码率主列表里的 `#EXT-X-MEDIA` /
 * `#EXT-X-STREAM-INF` 与广告无关，原样交回官方解析器，省一次无谓的改写。
 */
@UnstableApi
class AdFilteringPlaylistParserFactory(private val enabled: Boolean) : HlsPlaylistParserFactory {

    override fun createPlaylistParser(): ParsingLoadable.Parser<HlsPlaylist> =
        AdFilteringParser(enabled, null, null)

    override fun createPlaylistParser(
        multivariantPlaylist: HlsMultivariantPlaylist,
        previousMediaPlaylist: HlsMediaPlaylist?,
    ): ParsingLoadable.Parser<HlsPlaylist> =
        AdFilteringParser(enabled, multivariantPlaylist, previousMediaPlaylist)

    private class AdFilteringParser(
        private val enabled: Boolean,
        private val multivariantPlaylist: HlsMultivariantPlaylist?,
        private val previousMediaPlaylist: HlsMediaPlaylist?,
    ) : ParsingLoadable.Parser<HlsPlaylist> {

        override fun parse(uri: Uri, inputStream: InputStream): HlsPlaylist {
            val raw = inputStream.use { it.readBytes() }
            val text = raw.toString(Charsets.UTF_8)
            val body =
                if (enabled && text.contains("#EXTINF")) {
                    AdFilter.strip(text).toByteArray(Charsets.UTF_8)
                } else {
                    raw
                }
            val parser = if (multivariantPlaylist != null) {
                HlsPlaylistParser(multivariantPlaylist, previousMediaPlaylist)
            } else {
                HlsPlaylistParser()
            }
            return parser.parse(uri, ByteArrayInputStream(body))
        }
    }
}
