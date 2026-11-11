/**
 * 共用视觉组件与配色。
 *
 * 配色沿用桌面/TV 端的深色方案（bg #0A0C10、强调色 #FF6B3D），
 * 保证三端看起来是同一个产品。
 */

export class Palette {
  static readonly Accent: string = '#FF6B3D';
  static readonly AccentSoft: string = '#3A1D12';
  static readonly Bg: string = '#0A0C10';
  static readonly Panel: string = '#13171F';
  static readonly Panel2: string = '#1A202B';
  static readonly Line: string = '#242B38';
  static readonly TextPrimary: string = '#E9EDF5';
  static readonly TextMuted: string = '#8D97A8';
  static readonly OkGreen: string = '#4ECB8F';
  static readonly WarnAmber: string = '#F0B429';
  static readonly ErrRed: string = '#F2555A';
}

/** LazyForEach 用的简单数组数据源 */
export class ArrayDataSource<T> implements IDataSource {
  private items: T[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.items.length;
  }

  getData(index: number): T {
    return this.items[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }

  setItems(items: T[]): void {
    this.items = items;
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDataReloaded();
    }
  }

  size(): number {
    return this.items.length;
  }
}

/** 海报：等比 2:3，图挂了就用片名前两个字占位 */
@Component
export struct Poster {
  @Prop title: string = '';
  @Prop url: string = '';
  @Prop tall: boolean = true;
  @Prop showLabel: boolean = true;
  @State private failed: boolean = false;

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      if (!this.failed && this.url.length > 0) {
        Image(this.url)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .onError(() => {
            this.failed = true;
          })
      } else {
        Column() {
          Text(this.title.slice(0, 2))
            .fontSize(this.tall ? 22 : 15)
            .fontColor('#455063')
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#10141B')
      }

      if (this.showLabel) {
        Text(this.title)
          .width('100%')
          .padding({ left: 6, right: 6, top: 14, bottom: 6 })
          .fontSize(11)
          .fontColor(Palette.TextPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .linearGradient({
            angle: 180,
            colors: [['#00000000', 0.0], ['#CC05070A', 1.0]],
          })
      }
    }
    .width('100%')
    .aspectRatio(this.tall ? 0.69 : 1.0)
    .borderRadius(8)
    .clip(true)
    .backgroundColor('#10141B')
  }
}

/** 分组标题 */
@Component
export struct SectionTitle {
  @Prop title: string = '';
  @Prop hint: string = '';
  @Prop showMore: boolean = false;
  onMore: () => void = () => {
  };

  build() {
    Row({ space: 8 }) {
      Divider()
        .vertical(true)
        .height(16)
        .strokeWidth(3)
        .color(Palette.Accent)
      Text(this.title)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(Palette.TextPrimary)
      if (this.hint.length > 0) {
        Text(this.hint)
          .fontSize(11)
          .fontColor(Palette.TextMuted)
      }
      Blank()
      if (this.showMore) {
        Text('查看全部 ›')
          .fontSize(12)
          .fontColor(Palette.TextMuted)
          .onClick(() => {
            this.onMore();
          })
      }
    }
    .width('100%')
    .padding({ top: 16, bottom: 8 })
  }
}

/** 圆形/胶囊按钮 */
@Component
export struct PillButton {
  @Prop text: string = '';
  @Prop primary: boolean = false;
  @Prop disabled: boolean = false;
  onTap: () => void = () => {
  };

  build() {
    Text(this.text)
      .fontSize(13)
      .fontColor(this.primary ? '#1A0D07' : Palette.TextPrimary)
      .backgroundColor(this.primary ? Palette.Accent : Palette.Panel2)
      .borderRadius(999)
      .border({ width: 1, color: this.primary ? Palette.Accent : Palette.Line })
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
      .opacity(this.disabled ? 0.4 : 1)
      .onClick(() => {
        if (!this.disabled) {
          this.onTap();
        }
      })
  }
}

/** 小标签 */
@Component
export struct TagChip {
  @Prop text: string = '';
  @Prop active: boolean = false;
  onTap: () => void = () => {
  };

  build() {
    Text(this.text)
      .fontSize(12)
      .fontColor(this.active ? '#FFC4B0' : Palette.TextMuted)
      .backgroundColor(this.active ? Palette.AccentSoft : Palette.Panel)
      .borderRadius(999)
      .border({ width: 1, color: this.active ? Palette.Accent : Palette.Line })
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .onClick(() => {
        this.onTap();
      })
  }
}

/** 空态 */
@Component
export struct EmptyBox {
  @Prop title: string = '';
  @Prop description: string = '';
  @Prop actionText: string = '';
  onAction: () => void = () => {
  };

  build() {
    Column({ space: 10 }) {
      Text(this.title)
        .fontSize(15)
        .fontColor(Palette.TextPrimary)
      Text(this.description)
        .fontSize(12)
        .fontColor(Palette.TextMuted)
        .textAlign(TextAlign.Center)
      if (this.actionText.length > 0) {
        PillButton({
          text: this.actionText,
          primary: true,
          onTap: () => {
            this.onAction();
          },
        })
      }
    }
    .width('100%')
    .padding(24)
    .borderRadius(12)
    .border({ width: 1, color: Palette.Line })
    .backgroundColor('#0E1218')
    .justifyContent(FlexAlign.Center)
  }
}

/** 状态提示（加载中/失败之类的小字） */
@Component
export struct HintLine {
  @Prop text: string = '';
  @Prop color: string = Palette.TextMuted;

  build() {
    Text(this.text)
      .width('100%')
      .fontSize(12)
      .fontColor(this.color)
      .padding({ top: 6, bottom: 6 })
  }
}
