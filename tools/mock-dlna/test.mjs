/**
 * DLNA 发送端链路测试：SSDP 发现 → 解析设备描述 → SOAP 推送。
 * 运行：node tools/mock-dlna/test.mjs
 */

import assert from 'node:assert/strict';
import { startMockRenderer } from './server.mjs';
import { castToDevice, discoverDevices } from '../../apps/desktop/src/main/dlna.ts';

const server = await startMockRenderer();
console.log('mock renderer @', server.location);

try {
  // 1) SSDP 自动发现
  let devices = await discoverDevices({ timeoutMs: 1500 });
  console.log('SSDP discovered:', devices.map((d) => d.name));

  // 组播在部分 CI/容器里不可用，退化为手动指定设备描述地址（仍然验证后续链路）
  if (devices.length === 0) {
    devices = await discoverDevices({ timeoutMs: 100, locations: [server.location] });
    console.log('fallback manual location:', devices.map((d) => d.name));
  }
  assert.equal(devices.length, 1, '应发现 1 台设备');
  assert.equal(devices[0].name, 'Mock TV 客厅');

  // 2) 推送播放地址
  const url = 'https://cdn.example.com/movie/index.m3u8?token=abc&x=1';
  await castToDevice(devices[0], url, '流浪地球 · 第 1 集');

  const requests = server.requests;
  console.log('SOAP requests:', requests.map((r) => r.action));
  assert.deepEqual(
    requests.map((r) => r.action),
    ['SetAVTransportURI', 'Play']
  );
  assert.equal(requests[0].uri, url);
  assert.equal(requests[0].title, '流浪地球 · 第 1 集');
  assert.match(requests[0].soapAction, /AVTransport:1#SetAVTransportURI/);

  console.log('DLNA sender test passed ✓');
} finally {
  await server.close();
}
