import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { appModel } from '../model/AppModel';

const DOMAIN = 0x0000;
const TAG = 'LibreTV';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 先把持久化数据与内置源清单准备好，再加载界面：
    // 否则首页会先闪一下空列表，然后才补上内容。
    const context = this.context;
    appModel.start(context).then(() => {
      hilog.info(DOMAIN, TAG, 'app model ready: %{public}d sources', appModel.data.sources.length);
      this.loadUi(windowStage);
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'app model init failed: %{public}s', err.message);
      this.loadUi(windowStage);
    });
  }

  private loadUi(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
  }
}
