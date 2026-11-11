/**
 * 详情页：海报、简介、续播、换源、选集。
 *
 * 换源列表来自搜索结果里同名的其它源（AppModel.playFromDetail 会带上），
 * 与 TV 版行为一致：切源后集数会对齐到同一集号。
 */
import { appModel } from '../model/AppModel';
import { HistoryEntry, SearchItem, VodDetail } from '../model/Types';
import { Palette, Poster, PillButton, SectionTitle, HintLine, EmptyBox } from '../view/Common';

@Component
export struct DetailPage {
  @StorageLink('vmVersion') vmVersion: number = 0;

  private resumeEntry(item: SearchItem, vod: VodDetail | null): HistoryEntry | null {
    const id = `${item.sourceKey}:${item.vodId}`;
    const list = appModel.data.history;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    // 同名不同源也认为是同一部片子，进度可以带过去
    const target = normalize(item.name);
    for (let i = 0; i < list.length; i++) {
      if (normalize(list[i].title) === target) {
        return list[i];
      }
    }
    return null;
  }

  build() {
    Column() {
      // 顶部返回条
      Row({ space: 8 }) {
        Text('‹ 返回')
          .fontSize(14)
          .fontColor(Palette.TextMuted)
          .onClick(() => {
            appModel.back();
          })
        Blank()
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 6 })

      if (appModel.detailTarget === null) {
        EmptyBox({ title: '没有要显示的影片', description: '返回上一页重新选一部' })
        Blank()
      } else if (appModel.detail.loading && appModel.detail.detail === null) {
        Column() {
          LoadingProgress()
            .width(40)
            .height(40)
            .color(Palette.Accent)
          Text('正在获取播放地址…')
            .fontSize(12)
            .fontColor(Palette.TextMuted)
            .margin({ top: 10 })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (appModel.detail.detail === null) {
        Column() {
          EmptyBox({
            title: '无法获取播放地址',
            description: appModel.detail.error.length > 0 ? appModel.detail.error : '这个源暂时没有返回内容，换一个源试试',
            actionText: '返回换源',
            onAction: () => {
              appModel.back();
            },
          })
        }
        .width('100%')
        .layoutWeight(1)
        .padding(16)
      } else {
        this.content(appModel.detailTarget.item, appModel.detail.detail)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Palette.Bg)
  }

  @Builder
  content(item: SearchItem, vod: VodDetail) {
    Scroll() {
      Column() {
        // 头部
        Row({ space: 14 }) {
          Column() {
            Poster({ title: vod.title ?? item.name, url: vod.cover ?? item.pic ?? '' })
          }.width(104)
          Column({ space: 6 }) {
            Text(vod.title ?? item.name)
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(Palette.TextPrimary)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(metaLine(item, vod))
              .fontSize(11)
              .fontColor(Palette.TextMuted)
              .maxLines(2)
            Row({ space: 6 }) {
              Text(item.sourceName)
                .fontSize(10)
                .fontColor('#FFC4B0')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor(Palette.AccentSoft)
                .borderRadius(999)
                .border({ width: 1, color: Palette.Accent })
              if (this.resumeEntry(item, vod) !== null) {
                Text(`看到第 ${(this.resumeEntry(item, vod) as HistoryEntry).episodeIndex + 1} 集`)
                  .fontSize(10)
                  .fontColor(Palette.OkGreen)
                  .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                  .backgroundColor(Palette.Panel)
                  .borderRadius(999)
              }
            }
            Blank()
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          .height(156)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)

        // 简介
        Text(cleanDesc(vod.desc))
          .width('100%')
          .margin({ top: 10 })
          .fontSize(12)
          .lineHeight(19)
          .fontColor(Palette.TextMuted)
          .maxLines(4)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (vod.actor !== undefined && vod.actor.length > 0) {
          Text(`主演：${vod.actor}`)
            .width('100%')
            .margin({ top: 6 })
            .fontSize(11)
            .fontColor(Palette.TextMuted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }

        // 播放按钮
        Row({ space: 8 }) {
          PillButton({
            text: playLabel(this.resumeEntry(item, vod)),
            primary: true,
            onTap: () => {
              const entry = this.resumeEntry(item, vod);
              appModel.playFromDetail(entry === null ? 0 : entry.episodeIndex);
            },
          })
          PillButton({
            text: appModel.isFavorite(item) ? '已收藏' : '收藏',
            onTap: () => {
              appModel.toggleFavorite(item, vod.title ?? item.name, vod.cover ?? item.pic ?? '');
            },
          })
          Text(`共 ${vod.episodes.length} 集`)
            .fontSize(11)
            .fontColor(Palette.TextMuted)
        }
        .width('100%')
        .padding({ top: 12 })

        // 同名换源
        if (appModel.detailTarget !== null && appModel.detailTarget.group.length > 1) {
          SectionTitle({ title: '同片其它源', hint: `${appModel.detailTarget.group.length} 个` })
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(appModel.detailTarget.group, (other: SearchItem) => {
              Text(other.sourceName)
                .fontSize(11)
                .fontColor(other.sourceKey === item.sourceKey ? '#FFC4B0' : Palette.TextMuted)
                .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                .margin({ right: 8, bottom: 8 })
                .backgroundColor(other.sourceKey === item.sourceKey ? Palette.AccentSoft : Palette.Panel)
                .borderRadius(999)
                .border({ width: 1, color: other.sourceKey === item.sourceKey ? Palette.Accent : Palette.Line })
                .onClick(() => {
                  if (other.sourceKey !== item.sourceKey) {
                    appModel.openDetail(other, appModel.detailTarget === null ? [other] : appModel.detailTarget.group);
                  }
                })
            }, (other: SearchItem) => `${other.sourceKey}:${other.vodId}`)
          }
          .width('100%')
        }

        // 选集
        SectionTitle({ title: '选集', hint: `${vod.episodes.length} 集` })
        Grid() {
          ForEach(vod.episodes, (url: string, index: number) => {
            GridItem() {
              Text(`第 ${index + 1} 集`)
                .width('100%')
                .height(40)
                .textAlign(TextAlign.Center)
                .fontSize(12)
                .fontColor(isCurrentEp(item, index) ? '#FFC4B0' : Palette.TextPrimary)
                .backgroundColor(isCurrentEp(item, index) ? Palette.AccentSoft : Palette.Panel)
                .borderRadius(8)
                .border({ width: 1, color: isCurrentEp(item, index) ? Palette.Accent : Palette.Line })
                .onClick(() => {
                  appModel.playFromDetail(index);
                })
            }
          }, (url: string, index: number) => `${index}:${url}`)
        }
        .columnsTemplate('1fr 1fr 1fr 1fr')
        .columnsGap(8)
        .rowsGap(8)
        .width('100%')

        Column() {
          HintLine({ text: appModel.detail.error })
        }
        .width('100%')
        .margin({ top: 8 })
      }
      .padding({ left: 16, right: 16, bottom: 24 })
      .alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    .align(Alignment.Top)
  }
}

function playLabel(entry: HistoryEntry | null): string {
  if (entry === null) {
    return '立即播放';
  }
  return `继续播放 · 第 ${entry.episodeIndex + 1} 集`;
}

function isCurrentEp(item: SearchItem, index: number): boolean {
  return appModel.playerTarget !== null
    && appModel.playerTarget.vodId === item.vodId
    && appModel.playerTarget.source.key === item.sourceKey
    && appModel.playerTarget.startIndex === index;
}

function metaLine(item: SearchItem, vod: VodDetail): string {
  const parts: string[] = [];
  const year = vod.year ?? item.year;
  if (year !== undefined && year.length > 0) {
    parts.push(year);
  }
  const area = vod.area ?? item.area;
  if (area !== undefined && area.length > 0) {
    parts.push(area);
  }
  const type = vod.typeName ?? item.typeName;
  if (type !== undefined && type.length > 0) {
    parts.push(type);
  }
  const remarks = vod.remarks ?? item.remarks;
  if (remarks !== undefined && remarks.length > 0) {
    parts.push(remarks);
  }
  return parts.join(' · ');
}

function cleanDesc(desc: string | undefined): string {
  if (desc === undefined || desc.length === 0) {
    return '暂无简介';
  }
  return desc.replace(new RegExp('<[^>]+>', 'g'), ' ').replace(new RegExp('\\s+', 'g'), ' ').trim().slice(0, 220);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(new RegExp('[\\s\\p{P}\\p{S}]+', 'gu'), '');
}
