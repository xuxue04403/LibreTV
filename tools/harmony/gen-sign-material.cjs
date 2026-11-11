// 生成 hvigor 认可的签名密码密文与 material 目录，并直接写进 build-profile.json5。
// 算法逆向自 node_modules/@ohos/hvigor-ohos-plugin/src/utils/decipher-util.js
//   密钥 = AES-128-GCM 解密( pbkdf2(xor(fd1,fd2,fd3,component).toString(), salt, 10000, 16, sha256), ce 文件 )
//   密码密文格式 = [4字节 大端 (明文长度+16)] [12字节 IV] [密文] [16字节 GCM tag]，整体 hex
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMPONENT = new Int8Array([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119]);

const projectDir = path.resolve(process.argv[2]);
const plain = process.argv[3];
const signingDir = path.join(projectDir, 'signing');

// 每份材料必须是 16 字节
const fd = [0, 1, 2].map(() => crypto.randomBytes(16));
const salt = crypto.randomBytes(16);
const key = crypto.randomBytes(16);

const xorBytes = (a, b) => {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
};

// 与源码一致：xorComponents 返回 Buffer.from(Int8Array)，Buffer 的 toString() 按 UTF-8 解码字节
const rootMaterial = xorBytes(
  xorBytes(xorBytes(new Int8Array(fd[0]), new Int8Array(fd[1])), new Int8Array(fd[2])),
  COMPONENT
);
const rootMaterialBuf = Buffer.from(Array.from(rootMaterial, (v) => v & 0xff));
const rootKey = crypto.pbkdf2Sync(rootMaterialBuf.toString(), salt, 10000, 16, 'sha256');

const encrypt = (k, buf) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', k, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  const tag = c.getAuthTag();
  const head = Buffer.alloc(4);
  head.writeInt32BE(buf.length + 16, 0);
  return Buffer.concat([head, iv, body, tag]);
};

const ce = encrypt(rootKey, Buffer.from(key));

const root = path.join(signingDir, 'material');
fs.rmSync(root, { recursive: true, force: true });
for (const name of ['fd', 'ac', 'ce']) fs.mkdirSync(path.join(root, name), { recursive: true });
fd.forEach((buf, i) => {
  const d = path.join(root, 'fd', String(i + 1));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'data'), buf);
});
// ac / ce 目录里必须「只有一个文件」，再套一层子目录会 EISDIR
fs.writeFileSync(path.join(root, 'ac', 'salt.bin'), salt);
fs.writeFileSync(path.join(root, 'ce', 'work.bin'), ce);

const pwdHex = encrypt(key, Buffer.from(plain, 'utf-8')).toString('hex');

const profile = {
  app: {
    signingConfigs: [
      {
        name: 'default',
        type: 'HarmonyOS',
        material: {
          certpath: './signing/libretv-app.cer',
          storePassword: pwdHex,
          keyAlias: 'libretv-key',
          keyPassword: pwdHex,
          profile: './signing/profile.p7b',
          signAlg: 'SHA256withECDSA',
          storeFile: './signing/libretv.p12',
        },
      },
    ],
    products: [
      {
        name: 'default',
        signingConfig: 'default',
        compatibleSdkVersion: '26.0.0',
        targetSdkVersion: '26.0.0',
        runtimeOS: 'HarmonyOS',
        buildOption: {
          strictMode: { caseSensitiveCheck: true, useNormalizedOHMUrl: true },
        },
      },
    ],
    buildModeSet: [{ name: 'debug' }, { name: 'release' }],
  },
  modules: [
    {
      name: 'entry',
      srcPath: './entry',
      targets: [{ name: 'default', applyToProducts: ['default'] }],
    },
  ],
};

// JSON5 可接受标准 JSON，直接写合法 JSON 即可
fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify(profile, null, 2) + '\n');
console.log('material 与 build-profile.json5 已生成，密码长度 ' + plain.length);
