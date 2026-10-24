/**
 * 桌面端 DLNA 投屏（发送端）。
 *
 * 做三件事：
 * 1. SSDP 组播搜索局域网内的 MediaRenderer（电视 / 盒子 / 投影）；
 * 2. 拉取设备描述，找到 AVTransport 的控制地址；
 * 3. 通过 SOAP 把当前播放地址推给设备（SetAVTransportURI + Play）。
 *
 * 刻意不依赖 Electron：纯 Node 实现，便于用假渲染器做端到端测试。
 */

import dgram from 'node:dgram';
import os from 'node:os';
import net from 'node:net';

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

export interface DlnaDevice {
  /** 设备友好名 */
  name: string;
  /** 设备描述 URL */
  location: string;
  /** AVTransport 控制地址 */
  controlUrl: string;
}

interface DiscoverOptions {
  /** 搜索等待时间（毫秒），局域网通常 1-2 秒足够 */
  timeoutMs?: number;
  /** 额外指定的设备描述地址（手动添加） */
  locations?: string[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 从设备描述 XML 中提取名称与 AVTransport 控制地址 */
export function parseDeviceDescription(xml: string, location: string): DlnaDevice | null {
  const nameMatch = /<friendlyName>([\s\S]*?)<\/friendlyName>/i.exec(xml);
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  for (const block of serviceBlocks) {
    if (!block.includes(AVT_SERVICE)) continue;
    const control = /<controlURL>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1]?.trim();
    if (!control) continue;
    let controlUrl: string;
    try {
      controlUrl = new URL(control, location).href;
    } catch {
      continue;
    }
    // controlURL 必须是同源路径：允许任意绝对地址等于允许设备把 SOAP 引到别的主机
    if (new URL(controlUrl).origin !== new URL(location).origin) continue;
    return {
      name: nameMatch ? decodeXml(nameMatch[1]) : new URL(location).hostname,
      location,
      controlUrl,
    };
  }
  return null;
}

async function describe(location: string): Promise<DlnaDevice | null> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return parseDeviceDescription(await res.text(), location);
  } catch {
    return null;
  }
}

/** 本机所有非回环 IPv4 的 /16 前缀（投屏只可能来自同一网段） */
function localSubnets(): Set<string> {
  const prefixes = new Set<string>();
  // 回环要放进白名单：本机模拟渲染器（联调）与用户自己的同机投屏都走 127.0.0.1
  prefixes.add('127.0');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && info.address) {
        prefixes.add(info.address.split('.').slice(0, 2).join('.'));
      }
    }
  }
  return prefixes;
}

/**
 * 只接受与本机同网段的 SSDP 回包，避免被局域网外的伪造响应引到别的网段。
 *
 * 注意不能拿 `socket.address().address` 当基准：UDP socket 一般是 bind 到
 * `0.0.0.0`，那个值永远不可能是对方所在网段，会让所有回包被丢掉（投屏直接找不到设备）。
 */
function isSameSubnet(address: string, prefixes: Set<string>): boolean {
  if (prefixes.size === 0) return true;
  if (!net.isIPv4(address)) return false;
  return prefixes.has(address.split('.').slice(0, 2).join('.'));
}

/** 单飞：投屏面板挂载即探测、刷新按钮可连点，不能每次都新开 socket */
let inflight: Promise<DlnaDevice[]> | null = null;

/** SSDP 搜索：返回局域网内可投屏的设备 */
export async function discoverDevices(options: DiscoverOptions = {}): Promise<DlnaDevice[]> {
  if (inflight && !options.locations?.length) return inflight;
  const task = discoverOnce(options).finally(() => {
    inflight = null;
  });
  if (!options.locations?.length) inflight = task;
  return task;
}

async function discoverOnce(options: DiscoverOptions = {}): Promise<DlnaDevice[]> {
  const timeoutMs = options.timeoutMs ?? 2200;
  const locations = new Set<string>(options.locations ?? []);
  const subnets = localSubnets();

  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve();
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const location = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (!location || !/^https?:\/\//i.test(location)) return;
      // 只接受本机网段的响应：否则任意主机都能把自己伪装成渲染器，
      // 后续 SOAP 会被引到它指定的主机（SSRF）
      if (!isSameSubnet(rinfo.address, subnets)) return;
      locations.add(location);
    });

    socket.on('error', () => finish());
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* 部分网卡不支持广播 */
      }
      const targets = [AVT_SERVICE, 'ssdp:all'];
      for (const st of targets) {
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n')
        );
        try {
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_HOST);
        } catch {
          /* 网络不可用时静默跳过 */
        }
      }
      setTimeout(finish, timeoutMs);
    });
  });

  const devices = await Promise.all([...locations].map(describe));
  const unique = new Map<string, DlnaDevice>();
  for (const device of devices) {
    if (device && !unique.has(device.controlUrl)) unique.set(device.controlUrl, device);
  }
  return [...unique.values()];
}

function buildMetadata(url: string, title: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:video/mp4:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

async function soap(controlUrl: string, action: string, args: Record<string, string | number>): Promise<string> {
  const argsXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${typeof value === 'number' ? value : escapeXml(String(value))}</${key}>`)
    .join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVT_SERVICE}">${argsXml}</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AVT_SERVICE}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  if (!res.ok) {
    // UPnP 错误也返回 200，真正的失败通常在 body 的 errorCode 里
    throw new Error(`投屏失败（HTTP ${res.status}）`);
  }
  const errorCode = /<errorCode>(\d+)<\/errorCode>/i.exec(text)?.[1];
  if (errorCode && errorCode !== '0') {
    const description = /<errorDescription>([\s\S]*?)<\/errorDescription>/i.exec(text)?.[1];
    throw new Error(`设备拒绝投屏（${errorCode}${description ? `：${decodeXml(description)}` : ''}）`);
  }
  return text;
}

/** 把视频地址推送到设备并开始播放 */
export async function castToDevice(device: DlnaDevice, url: string, title: string): Promise<void> {
  await soap(device.controlUrl, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: buildMetadata(url, title),
  });
  await soap(device.controlUrl, 'Play', { InstanceID: 0, Speed: 1 });
}

/** 停止设备上的投屏 */
export async function stopCast(device: DlnaDevice): Promise<void> {
  await soap(device.controlUrl, 'Stop', { InstanceID: 0 });
}
